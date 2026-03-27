import { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { ok, err, withErrorHandler } from '@/lib/api-helpers';
import type { DbClaim, DbProject, DbVerificationRun } from '@/lib/db-types';

export const runtime = 'nodejs';

// This route only dispatches — it returns in seconds, not minutes.
export const maxDuration = 30;

export const POST = withErrorHandler(async (req: Request) => {
  const body  = await (req as NextRequest).json().catch(() => ({}));
  const runId = (body?.runId ?? '').trim();

  if (!runId) return err('runId is required');

  // ── Fetch run ─────────────────────────────────────────────────────────────
  const { data: run, error: runErr } = await supabase
    .from('verification_runs')
    .select('*')
    .eq('id', runId)
    .single<DbVerificationRun>();

  if (runErr || !run) return err('Run not found', 404);

  // ── Fetch project ─────────────────────────────────────────────────────────
  const { data: project } = await supabase
    .from('projects')
    .select('*')
    .eq('id', run.project_id)
    .single<DbProject>();

  if (!project) return err('Project not found', 404);

  if (!project.website) {
    await supabase.from('verification_runs').update({ status: 'complete' }).eq('id', runId);
    await log(runId, 'No website on record — automated verification skipped');
    return ok({ runId, results: [], message: 'No website to verify' });
  }

  // ── Fetch pending claims ──────────────────────────────────────────────────
  const { data: claims } = await supabase
    .from('claims')
    .select('*')
    .eq('verification_run_id', runId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .returns<DbClaim[]>();

  if (!claims?.length) {
    await supabase.from('verification_runs').update({ status: 'complete' }).eq('id', runId);
    return ok({ runId, results: [], message: 'No pending claims' });
  }

  // ── Mark run as verifying ─────────────────────────────────────────────────
  await supabase.from('verification_runs').update({ status: 'verifying' }).eq('id', runId);
  await log(runId, `Browser verification starting — ${claims.length} claim(s)`);
  await log(runId, `Target: ${project.website}`);

  // ── Dispatch each claim to its own Lambda ─────────────────────────────────
  // Each /api/verify/claim invocation gets its own 300s timeout, so even
  // 10 claims won't cause a single-function timeout.
  const origin = new URL((req as NextRequest).url).origin;

  for (const [idx, claim] of claims.entries()) {
    await log(runId, `Claim ${String(idx + 1).padStart(2, '0')}: ${claim.claim}`);

    // Fire-and-forget — we don't await the response.
    fetch(`${origin}/api/verify/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, claimId: claim.id }),
    }).catch((e) => {
      console.error(`[verify/run] Failed to dispatch claim ${claim.id}:`, e);
    });
  }

  console.log(`[verify/run] Dispatched ${claims.length} claim(s) for run ${runId}`);

  // Return immediately — the frontend polls /api/verify/status for progress.
  // Return empty results array for backward compatibility.
  return ok({ runId, results: [] });
});
