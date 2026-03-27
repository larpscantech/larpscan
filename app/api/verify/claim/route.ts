import { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { determineVerdict } from '@/lib/verdict';
import { routeVerification, type StructuredClaim } from '@/lib/verification-graph';
import { ok, err, withErrorHandler } from '@/lib/api-helpers';
import type { DbClaim, DbProject, DbVerificationRun } from '@/lib/db-types';

export const runtime = 'nodejs';
export const maxDuration = 300;

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

  // ── Mark as checking ──────────────────────────────────────────────────────
  await supabase.from('claims').update({ status: 'checking' }).eq('id', claimId);

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
    verifyResult = await routeVerification(
      project.website,
      structuredClaim,
      project.contract_address,
    );
    evidenceSummary   = verifyResult.evidenceSummary;
    screenshotDataUrl = verifyResult.screenshotDataUrl;
    videoUrl          = verifyResult.videoUrl;

    if (videoUrl) console.log(`[verify/claim] Video: ${videoUrl}`);

    const lines = evidenceSummary.split('\n').filter(Boolean);
    for (const line of lines) {
      await log(runId, line);
    }

    if (!verifyResult.siteLoaded) {
      const fastVerdict = verifyResult.blocked ? 'untestable' : 'failed';
      await supabase.from('claims').update({ status: fastVerdict }).eq('id', claimId);
      await saveEvidence(claimId, evidenceSummary, fastVerdict, 'Site unreachable or bot-blocked', 'high', screenshotDataUrl);
      await log(runId, `verdict → ${fastVerdict.toUpperCase()} (high confidence)`);
      await maybeCompleteRun(runId);
      return ok({ claimId, verdict: fastVerdict, confidence: 'high' });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown Playwright error';
    console.error('[verify/claim] Playwright error:', e);
    evidenceSummary = `Browser error: ${msg}`;
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
  );

  await supabase.from('claims').update({ status: verdict.verdict }).eq('id', claimId);
  await log(runId, `verdict → ${verdict.verdict.toUpperCase()} (${verdict.confidence} confidence)`);
  await log(runId, verdict.reasoning);

  if (verifyResult?.signals?.transactionHash) {
    await log(runId, `On-chain tx: https://bscscan.com/tx/${verifyResult.signals.transactionHash}`);
  } else if (verifyResult?.signals?.transactionAttempted) {
    await log(runId, `Transaction was attempted but not broadcast (insufficient BNB for gas)`);
  }

  await maybeCompleteRun(runId);

  return ok({ claimId, verdict: verdict.verdict, confidence: verdict.confidence });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function maybeCompleteRun(runId: string) {
  const { data: remaining } = await supabase
    .from('claims')
    .select('id')
    .eq('verification_run_id', runId)
    .in('status', ['pending', 'checking']);

  if (!remaining?.length) {
    await supabase
      .from('verification_runs')
      .update({ status: 'complete' })
      .eq('id', runId);
    await log(runId, 'Verification complete');
    console.log('[verify/claim] All claims done — run marked complete');
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
    },
  });
  if (error) {
    console.error('[verify/claim] Failed to save evidence:', error.message);
  }
}
