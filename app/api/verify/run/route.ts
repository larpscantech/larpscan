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

  // ── Fetch all pending claims ──────────────────────────────────────────────
  const { data: allPending } = await supabase
    .from('claims')
    .select('*')
    .eq('verification_run_id', runId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .returns<DbClaim[]>();

  // Already-checking claims count as "dispatched" — no duplicate runs needed.
  const alreadyRunning = checkingClaims?.length ?? 0;
  const pendingClaims  = allPending ?? [];

  if (!pendingClaims.length && !alreadyRunning) {
    await supabase.from('verification_runs').update({ status: 'complete' }).eq('id', runId);
    return ok({ runId, results: [], message: 'No pending claims' });
  }

  if (!pendingClaims.length) {
    // All claims already dispatched and running — nothing to do.
    return ok({ runId, results: [], message: 'All claims already running' });
  }

  // ── Mark run as verifying ─────────────────────────────────────────────────
  await supabase.from('verification_runs').update({ status: 'verifying' }).eq('id', runId);
  await log(runId, `Browser verification starting — ${pendingClaims.length} claim(s) in parallel`);
  await log(runId, `Target: ${project.website}`);

  // ── Atomically claim + dispatch ALL pending claims in parallel ────────────
  // Each claim row is atomically flipped to "checking" via a conditional
  // UPDATE (.eq('status','pending')) before firing the fetch, preventing
  // duplicate workers if this endpoint is called more than once.
  const origin = new URL((req as NextRequest).url).origin;

  const dispatched: string[] = [];

  await Promise.all(
    pendingClaims.map(async (claim) => {
      const { data: claimed } = await supabase
        .from('claims')
        .update({ status: 'checking' })
        .eq('id', claim.id)
        .eq('status', 'pending')
        .select('id')
        .single<{ id: string }>();

      if (!claimed) {
        console.log(`[verify/run] Claim ${claim.id} already taken — skipping`);
        return;
      }

      dispatched.push(claim.id);
      await log(runId, `Dispatching claim: ${claim.claim}`);

      fetch(`${origin}/api/verify/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, claimId: claim.id }),
      }).catch((e) => {
        console.error(`[verify/run] Failed to dispatch claim ${claim.id}:`, e);
      });
    }),
  );

  console.log(`[verify/run] Dispatched ${dispatched.length} claim(s) in parallel for run ${runId}`);

  // Return immediately — the frontend polls /api/verify/status for progress.
  return ok({ runId, results: [], dispatched });
});
