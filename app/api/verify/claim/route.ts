import { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { determineVerdict } from '@/lib/verdict';
import { routeVerification, type StructuredClaim } from '@/lib/verification-graph';
import { ok, err, withErrorHandler } from '@/lib/api-helpers';
import { getFastTrackVerdict, recordClaimResult } from '@/lib/platform-context';
import type { DbClaim, DbProject, DbVerificationRun } from '@/lib/db-types';

export const runtime = 'nodejs';
export const maxDuration = 540; // Must exceed STUCK_CHECKING_MS (8 min = 480s) with overhead

// Hard wall: abort the browser session well before Vercel kills the whole function.
// Increased to 550s on local dev to allow TOKEN_CREATION enough time to:
// - Retry through Browserless 429s / timeouts (up to 315s of retries)  
// - Run the actual browser session (up to 370s session kill)
const CLAIM_TIMEOUT_MS = 550_000;

function summarizeBrowserFailure(error: unknown): string {
  const msg = error instanceof Error ? error.message : 'Unknown Playwright error';
  if (/startsWith/i.test(msg) || /Cannot read propert(?:y|ies) of (?:undefined|null)/i.test(msg)) {
    return 'Browser interaction failed before stable evidence was captured';
  }
  return 'Browser interaction failed before verification could complete';
}

export const POST = withErrorHandler(async (req: Request) => {
  const body = await (req as NextRequest).json().catch(() => ({}));
  const runId   = (body?.runId   ?? '').trim();
  const claimId = (body?.claimId ?? '').trim();

  if (!runId || !claimId) return err('runId and claimId are required');

  // ── Fetch claim + run + project ───────────────────────────────────────────
  const [claimRes, runRes] = await Promise.all([
    supabase.from('claims').select('*').eq('id', claimId).single<DbClaim>(),
    supabase.from('verification_runs').select('*').eq('id', runId).single<DbVerificationRun>(),
  ]);

  const claim = claimRes.data;
  const run   = runRes.data;
  if (!claim || !run) return err('Claim or run not found', 404);

  const { data: project } = await supabase
    .from('projects')
    .select('*')
    .eq('id', run.project_id)
    .single<DbProject>();

  if (!project?.website) return err('Project or website not found', 404);

  console.log(`[verify/claim] ══ ${claim.claim.slice(0, 60)} ══`);

  // ── Mark as checking if still pending, and record actual start time ───────
  await supabase.from('claims').update({ status: 'checking' }).eq('id', claimId).eq('status', 'pending');
  await log(runId, `claim-start:${claimId}`);

  // ── Platform-level fast-track check ──────────────────────────────────────
  // If a previous claim in this run already discovered a platform-wide blocker
  // (bot protection, full auth-gate), skip the browser session entirely.
  const fastTrack = getFastTrackVerdict(runId);
  if (fastTrack) {
    console.log(`[verify/claim] Fast-track → ${fastTrack.verdict}: ${fastTrack.reason}`);
    await supabase.from('claims').update({ status: fastTrack.verdict }).eq('id', claimId);
    await saveEvidence(claimId, fastTrack.reason, fastTrack.verdict, fastTrack.reason, 'high');
    await log(runId, `verdict → ${fastTrack.verdict.toUpperCase()} (platform context fast-track)`);
    await log(runId, fastTrack.reason);
    await maybeCompleteRun(runId, new URL((req as NextRequest).url).origin);
    return ok({ claimId, verdict: fastTrack.verdict, confidence: 'high' });
  }

  let evidenceSummary   = 'No evidence collected';
  let screenshotDataUrl: string | undefined;
  let videoUrl:          string | undefined;
  let verifyResult:      Awaited<ReturnType<typeof routeVerification>> | undefined;

  const structuredClaim: StructuredClaim = {
    id:                    claim.id,
    claim:                 claim.claim,
    pass_condition:        claim.pass_condition,
    feature_type:          claim.feature_type ?? null,
    surface:               claim.surface ?? null,
    verification_strategy: claim.verification_strategy ?? null,
  };

  try {
    verifyResult = await Promise.race([
      routeVerification(project.website, structuredClaim, project.contract_address),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Claim verification timed out after ${CLAIM_TIMEOUT_MS / 1_000}s`)),
          CLAIM_TIMEOUT_MS,
        ),
      ),
    ]);
    evidenceSummary   = verifyResult.evidenceSummary;
    screenshotDataUrl = verifyResult.screenshotDataUrl;
    videoUrl          = verifyResult.videoUrl;

    if (videoUrl) console.log(`[verify/claim] Video: ${videoUrl}`);

    const lines = evidenceSummary.split('\n').filter(Boolean);
    for (const line of lines) {
      await log(runId, line);
    }

    if (!verifyResult.siteLoaded) {
      // Network failures (timeout, DNS, SSL, chrome-error) are UNTESTABLE, not FAILED.
      // The site being unreachable doesn't prove the feature doesn't exist — it's a
      // transient infra issue. Only use FAILED when we're certain the feature is broken.
      const fastVerdict = 'untestable';
      await supabase.from('claims').update({ status: fastVerdict }).eq('id', claimId);
      await saveEvidence(claimId, evidenceSummary, fastVerdict, verifyResult.blocked ? 'Platform is bot-blocked or auth-gated' : 'Site unreachable — network or SSL error during test session', 'high', screenshotDataUrl);
      await log(runId, `verdict → ${fastVerdict.toUpperCase()} (high confidence)`);
      await maybeCompleteRun(runId, new URL((req as NextRequest).url).origin);
      return ok({ claimId, verdict: fastVerdict, confidence: 'high' });
    }
  } catch (e) {
    console.error('[verify/claim] Playwright error:', e);
    evidenceSummary = summarizeBrowserFailure(e);
    await log(runId, evidenceSummary);
  }

  // ── Two-layer verdict ─────────────────────────────────────────────────────
  const verdict = await determineVerdict(
    claim.claim,
    claim.pass_condition,
    evidenceSummary,
    verifyResult?.signals,
    claim.feature_type ?? undefined,
    verifyResult?.finalScreenshotDataUrl,
  );

  console.log(`[verify/claim] Verdict: ${verdict.verdict} (${verdict.confidence})`, verdict.reasoning);

  await saveEvidence(
    claimId,
    evidenceSummary,
    verdict.verdict,
    verdict.reasoning,
    verdict.confidence,
    screenshotDataUrl,
    videoUrl,
    verifyResult?.signals?.transactionHash,
    verifyResult?.signals?.transactionExplorerUrl,
    verifyResult?.signals?.transactionReceiptStatus,
    verifyResult?.signals?.transactionAttempted,
    verifyResult?.signals?.walletEvidence?.walletAddress,
    verdict.blockerReason,
  );

  await supabase.from('claims').update({ status: verdict.verdict }).eq('id', claimId);
  await log(runId, `verdict → ${verdict.verdict.toUpperCase()} (${verdict.confidence} confidence)`);
  await log(runId, verdict.reasoning);

  // Record platform-level blockers so subsequent claims can fast-track
  recordClaimResult(runId, verifyResult?.signals?.blockersEncountered ?? [], verdict.verdict);

  if (verifyResult?.signals?.transactionHash) {
    await log(runId, `On-chain tx: https://bscscan.com/tx/${verifyResult.signals.transactionHash}`);
  } else if (verifyResult?.signals?.transactionAttempted) {
    await log(runId, `Transaction was attempted but not broadcast (insufficient BNB for gas)`);
  }

  await maybeCompleteRun(runId, new URL((req as NextRequest).url).origin);

  return ok({ claimId, verdict: verdict.verdict, confidence: verdict.confidence });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function maybeCompleteRun(runId: string, origin: string) {
  const { data: remaining } = await supabase
    .from('claims')
    .select('id, status')
    .eq('verification_run_id', runId)
    .in('status', ['pending', 'checking']);

  const pendingOnly = (remaining ?? []).filter((c) => c.status === 'pending');

  if (!remaining?.length) {
    await supabase
      .from('verification_runs')
      .update({ status: 'complete' })
      .eq('id', runId);
    await log(runId, 'Verification complete');
    console.log('[verify/claim] All claims done — run marked complete');
  } else if (pendingOnly.length > 0) {
    // Daisy-chain: fire the next pending claim now that this one is done.
    // Import lazily to avoid circular-dependency issues at module load time.
    // 30 s cooldown: gives Browserless time to finish encoding the previous
    // session's video, release memory, and drain its internal CDP queue before
    // the next (potentially heavy) session starts.
    const { dispatchNextClaim } = await import('@/lib/claim-dispatcher');
    dispatchNextClaim(runId, origin, 30_000).catch((e) =>
      console.error('[verify/claim] Failed to dispatch next claim:', e),
    );
  }
}

async function saveEvidence(
  claimId:              string,
  evidenceSummary:      string,
  verdict:              string,
  reasoning:            string,
  confidence:           string,
  screenshotDataUrl?:   string,
  videoUrl?:            string,
  transactionHash?:     string,
  transactionExplorerUrl?: string,
  transactionReceiptStatus?: 'success' | 'reverted' | 'timeout',
  transactionAttempted?: boolean,
  walletAddress?:        string,
  blockerReason?:        string,
) {
  const { error } = await supabase.from('evidence_items').insert({
    claim_id: claimId,
    type:     'browser_verification',
    data: {
      evidenceSummary,
      verdict,
      reasoning,
      confidence,
      ...(screenshotDataUrl      ? { screenshotDataUrl }      : {}),
      ...(videoUrl               ? { videoUrl }               : {}),
      ...(transactionHash        ? { transactionHash }        : {}),
      ...(transactionExplorerUrl ? { transactionExplorerUrl } : {}),
      ...(transactionReceiptStatus ? { transactionReceiptStatus } : {}),
      ...(transactionAttempted   ? { transactionAttempted }   : {}),
      ...(walletAddress          ? { walletAddress }          : {}),
      ...(blockerReason          ? { blockerReason }          : {}),
    },
  });
  if (error) {
    console.error('[verify/claim] Failed to save evidence:', error.message);
  }
}
