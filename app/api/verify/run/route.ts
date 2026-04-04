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

  const { data: checkingClaims } = await supabase
    .from('claims')
    .select('*')
    .eq('verification_run_id', runId)
    .eq('status', 'checking')
    .order('created_at', { ascending: true })
    .returns<DbClaim[]>();

  if (checkingClaims?.length) {
    return ok({ runId, results: [], message: 'A claim is already running' });
  }

  // ── Fetch next pending claim only ─────────────────────────────────────────
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

  // ── Dispatch exactly one claim ────────────────────────────────────────────
  // Running claims sequentially removes cross-claim contention (Browserless,
  // OpenAI, wallet mock state, Supabase writes) and stops "pending" claims
  // from aging out before they even start.
  const origin = new URL((req as NextRequest).url).origin;
  const claim = claims[0];
  await log(runId, `Dispatching claim: ${claim.claim}`);

  // Claim the row before dispatch so duplicate /api/verify/run calls cannot
  // start the same claim twice.
  const { data: claimed } = await supabase
    .from('claims')
    .update({ status: 'checking' })
    .eq('id', claim.id)
    .eq('status', 'pending')
    .select('*')
    .single<DbClaim>();

  if (!claimed) {
    return ok({ runId, results: [], message: 'Claim was already claimed by another worker' });
  }

  fetch(`${origin}/api/verify/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, claimId: claim.id }),
  }).catch((e) => {
    console.error(`[verify/run] Failed to dispatch claim ${claim.id}:`, e);
  });

  console.log(`[verify/run] Dispatched claim ${claim.id} for run ${runId}`);

  // Return immediately — the frontend polls /api/verify/status for progress.
  // Return empty results array for backward compatibility.
  return ok({ runId, results: [] });
});
