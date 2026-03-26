import { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { determineVerdict } from '@/lib/verdict';
import { routeVerification, type StructuredClaim } from '@/lib/verification-graph';
import { ok, err, withErrorHandler } from '@/lib/api-helpers';
import type { DbClaim, DbProject, DbVerificationRun } from '@/lib/db-types';

// Force Node.js runtime — required for native binaries (Playwright, ffmpeg-static).
// The edge runtime does not support child processes or filesystem access.
export const runtime = 'nodejs';

// Allow up to 5 minutes — Playwright verification is slow per claim.
// On Vercel Pro this can be up to 300s; self-hosted has no limit.
export const maxDuration = 300;

export const POST = withErrorHandler(async (req: Request) => {
  const body  = await (req as NextRequest).json().catch(() => ({}));
  const runId = (body?.runId ?? '').trim();

  if (!runId) return err('runId is required');

  console.group('[verify/run] ══ Starting verification run ══');
  console.log('  runId:', runId);

  // ── Fetch run ───────────────────────────────────────────────────────────────
  const { data: run, error: runErr } = await supabase
    .from('verification_runs')
    .select('*')
    .eq('id', runId)
    .single<DbVerificationRun>();

  if (runErr || !run) {
    console.error('[verify/run] Run not found:', runErr?.message);
    console.groupEnd();
    return err('Run not found', 404);
  }

  // ── Fetch project ───────────────────────────────────────────────────────────
  const { data: project } = await supabase
    .from('projects')
    .select('*')
    .eq('id', run.project_id)
    .single<DbProject>();

  if (!project) {
    console.error('[verify/run] Project not found for run:', runId);
    console.groupEnd();
    return err('Project not found', 404);
  }

  console.log('  project:', project.name, '|', project.website);

  // ── No website → skip verification ─────────────────────────────────────────
  if (!project.website) {
    await supabase
      .from('verification_runs')
      .update({ status: 'complete' })
      .eq('id', runId);
    await log(runId, 'No website on record — automated verification skipped');
    console.warn('[verify/run] No website — skipping');
    console.groupEnd();
    return ok({ runId, results: [], message: 'No website to verify' });
  }

  // ── Fetch pending claims ────────────────────────────────────────────────────
  const { data: claims } = await supabase
    .from('claims')
    .select('*')
    .eq('verification_run_id', runId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .returns<DbClaim[]>();

  if (!claims?.length) {
    await supabase
      .from('verification_runs')
      .update({ status: 'complete' })
      .eq('id', runId);
    console.warn('[verify/run] No pending claims found');
    console.groupEnd();
    return ok({ runId, results: [], message: 'No pending claims' });
  }

  console.log(`  claims to verify: ${claims.length}`);

  // ── Mark run as verifying ───────────────────────────────────────────────────
  await supabase
    .from('verification_runs')
    .update({ status: 'verifying' })
    .eq('id', runId);

  await log(runId, `Browser verification starting — ${claims.length} claim(s)`);
  await log(runId, `Target: ${project.website}`);

  // ── Verify each claim sequentially ─────────────────────────────────────────
  const results: { claimId: string; verdict: string; confidence: string }[] = [];

  for (const [idx, claim] of claims.entries()) {
    console.group(`[verify/run] Claim ${idx + 1}/${claims.length}: "${claim.claim.slice(0, 60)}"`);

    // Mark as checking
    await supabase.from('claims').update({ status: 'checking' }).eq('id', claim.id);
    await log(runId, `[ Claim ${String(idx + 1).padStart(2, '0')} ] ${claim.claim}`);

    let evidenceSummary   = 'No evidence collected';
    let screenshotDataUrl: string | undefined;
    let videoUrl:          string | undefined;
    let verifyResult:      Awaited<ReturnType<typeof routeVerification>> | undefined;

    // ── Route through verification graph ─────────────────────────────────────
    const structuredClaim: StructuredClaim = {
      id:                    claim.id,
      claim:                 claim.claim,
      pass_condition:        claim.pass_condition,
      feature_type:          claim.feature_type ?? null,
      surface:               claim.surface ?? null,
      verification_strategy: claim.verification_strategy ?? null,
    };

    await log(
      runId,
      `Strategy: ${claim.feature_type ?? 'UI_FEATURE'} → ${claim.verification_strategy ?? 'ui+browser'}` +
      (claim.surface ? ` (${claim.surface})` : ''),
    );

    try {
      verifyResult = await routeVerification(
        project.website!,
        structuredClaim,
        project.contract_address,
      );
      evidenceSummary   = verifyResult.evidenceSummary;
      screenshotDataUrl = verifyResult.screenshotDataUrl;
      videoUrl          = verifyResult.videoUrl;
      if (videoUrl) {
        console.log(`[verify/run] Video recorded: ${videoUrl}`);
      }

      console.log('[verify/run] Evidence:\n', evidenceSummary);
      if (screenshotDataUrl) {
        console.log(`[verify/run] Screenshot captured (${Math.round(screenshotDataUrl.length / 1024)}KB)`);
      }

      // Log each probe line to agent_logs
      const lines = evidenceSummary.split('\n').filter(Boolean);
      for (const line of lines) {
        await log(runId, line);
      }

      // Short-circuit when site is broken / blocked
      if (!verifyResult.siteLoaded) {
        const fastVerdict: string = verifyResult.blocked ? 'untestable' : 'failed';
        await supabase.from('claims').update({ status: fastVerdict }).eq('id', claim.id);
        await saveEvidence(claim.id, evidenceSummary, fastVerdict, 'Site unreachable or bot-blocked', 'high', screenshotDataUrl);
        await log(runId, `verdict → ${fastVerdict.toUpperCase()} (high confidence)`);
        results.push({ claimId: claim.id, verdict: fastVerdict, confidence: 'high' });
        console.log('[verify/run] Fast verdict:', fastVerdict);
        console.groupEnd();
        continue;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown Playwright error';
      console.error('[verify/run] Playwright error:', e);
      evidenceSummary = `Browser error: ${msg}`;
      await log(runId, evidenceSummary);
    }

    // ── Two-layer verdict (deterministic rules → LLM fallback) ───────────────
    const verdict = await determineVerdict(
      claim.claim,
      claim.pass_condition,
      evidenceSummary,
      verifyResult?.signals,
      claim.feature_type ?? undefined,
      verifyResult?.finalScreenshotDataUrl,
    );
    console.log(
      `[verify/run] Final verdict: ${verdict.verdict} (${verdict.confidence})`,
      verdict.reasoning,
    );

    // Persist evidence + update claim status
    await saveEvidence(
      claim.id,
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
    await supabase.from('claims').update({ status: verdict.verdict }).eq('id', claim.id);
    await log(runId, `verdict → ${verdict.verdict.toUpperCase()} (${verdict.confidence} confidence)`);
    await log(runId, verdict.reasoning);
    if (verifyResult?.signals?.transactionHash) {
      await log(runId, `🔗 On-chain tx: https://bscscan.com/tx/${verifyResult.signals.transactionHash}`);
    } else if (verifyResult?.signals?.transactionAttempted) {
      await log(runId, `⚡ Transaction was attempted but not broadcast (insufficient BNB for gas)`);
    }

    results.push({ claimId: claim.id, verdict: verdict.verdict, confidence: verdict.confidence });
    console.groupEnd();
  }

  // ── Mark run complete ───────────────────────────────────────────────────────
  await supabase
    .from('verification_runs')
    .update({ status: 'complete' })
    .eq('id', runId);
  await log(runId, 'Verification complete');

  console.log('[verify/run] ══ Run complete ══', results);
  console.groupEnd();

  return ok({ runId, results });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

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
    console.error('[verify/run] Failed to save evidence:', error.message);
  }
}
