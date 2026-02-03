import { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { ok, err, withErrorHandler } from '@/lib/api-helpers';
import type { DbProject, DbVerificationRun } from '@/lib/db-types';

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

  // ── Check for already-dispatched claims (idempotency) ────────────────────
  const { data: checkingClaims } = await supabase
    .from('claims')
    .select('id')
    .eq('verification_run_id', runId)
    .eq('status', 'checking');

  const { data: pendingClaims } = await supabase
    .from('claims')
    .select('id')
    .eq('verification_run_id', runId)
    .eq('status', 'pending');

  const alreadyRunning = (checkingClaims?.length ?? 0) > 0;
  const hasPending     = (pendingClaims?.length ?? 0) > 0;

  if (!hasPending && !alreadyRunning) {
    await supabase.from('verification_runs').update({ status: 'complete' }).eq('id', runId);
    return ok({ runId, results: [], message: 'No pending claims' });
  }

  if (!hasPending) {
    return ok({ runId, results: [], message: 'All claims already running' });
  }

  // ── Always queue — status route is the sole promoter ─────────────────────
  // /run never dispatches directly. This avoids the TOCTOU race where /run
  // and /status both see 0 active runs and both try to dispatch.
  // The status poller (which fires every ~15s) will promote this run to
  // `verifying` as soon as a slot is free. For the first run ever, that
  // happens on the very first status poll (usually within 1-2 seconds).
  await log(runId, 'Run queued — waiting for verification slot');

  // Calculate queue position (best-effort — never fail the route if count breaks)
  let queuePosition = 1;
  if (run.created_at) {
    const { count: aheadCount, error: queueErr } = await supabase
      .from('verification_runs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')
      .lt('created_at', run.created_at);

    if (queueErr) {
      console.error('[verify/run] queue count error:', queueErr.message);
    } else {
      queuePosition = (aheadCount ?? 0) + 1;
    }
  }

  console.log(`[verify/run] Run ${runId} queued (position ${queuePosition})`);
  return ok({ runId, results: [], status: 'queued', queuePosition });
});
