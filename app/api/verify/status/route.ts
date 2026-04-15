import { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { ok, err, withErrorHandler } from '@/lib/api-helpers';
import { countActiveVerifyingRuns, dispatchClaimsForRun, MAX_CONCURRENT_RUNS } from '@/lib/claim-dispatcher';
import type { DbVerificationRun, DbAgentLog, DbClaimWithEvidence, DbProject } from '@/lib/db-types';

const STUCK_CHECKING_MS = 8 * 60 * 1000; // 8 min — 8 LLM steps × 25s + 60s overhead = ~260s, 8 min is a generous safety margin

function claimStartTimes(logs: DbAgentLog[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const logRow of logs) {
    const match = logRow.message.match(/^claim-start:([a-f0-9-]+)$/i);
    if (!match) continue;
    const ts = new Date(logRow.created_at).getTime();
    if (!Number.isNaN(ts)) map.set(match[1], ts);
  }
  return map;
}

export const GET = withErrorHandler(async (req: Request) => {
  const { searchParams } = new URL((req as NextRequest).url);
  const runId = searchParams.get('runId')?.trim();

  if (!runId) {
    return err('runId query parameter is required');
  }

  const [runResult, claimsResult, logsResult] = await Promise.all([
    supabase
      .from('verification_runs')
      .select('*')
      .eq('id', runId)
      .single<DbVerificationRun>(),

    supabase
      .from('claims')
      .select('*, evidence_items(*)')
      .eq('verification_run_id', runId)
      .order('created_at', { ascending: true })
      .returns<DbClaimWithEvidence[]>(),

    supabase
      .from('agent_logs')
      .select('*')
      .eq('verification_run_id', runId)
      .order('created_at', { ascending: true })
      .returns<DbAgentLog[]>(),
  ]);

  if (runResult.error || !runResult.data) {
    return err('Verification run not found', 404);
  }

  const run = runResult.data;
  let claims = claimsResult.data ?? [];
  const logs = logsResult.data ?? [];

  // Fetch the associated project so callers don't need a second round-trip
  const { data: project } = await supabase
    .from('projects')
    .select('*')
    .eq('id', run.project_id)
    .maybeSingle<DbProject>();

  const origin = new URL((req as NextRequest).url).origin;

  // ── Auto-heal stuck claims ────────────────────────────────────────────────
  // Claims stuck in "checking" beyond the threshold get marked untestable so
  // the run can complete and the queue can advance.
  if (run.status !== 'complete' && run.status !== 'failed') {
    const now = Date.now();
    let healed = false;
    const startTimes = claimStartTimes(logs);

    for (const claim of claims) {
      const startTs = startTimes.get(claim.id) ?? new Date(claim.created_at).getTime();
      const age = now - startTs;
      const stuckChecking = claim.status === 'checking' && age > STUCK_CHECKING_MS;

      if (stuckChecking) {
        console.warn(`[verify/status] Auto-healing stuck claim ${claim.id} (checking for ${Math.round(age / 1000)}s)`);
        await supabase.from('claims').update({ status: 'untestable' }).eq('id', claim.id);
        await log(runId, `Claim timed out — browser worker exceeded time limit`);
        claim.status = 'untestable';
        healed = true;
      }
    }

    // Close the run when every claim is in a terminal state
    const allDone = claims.every((c) => c.status !== 'pending' && c.status !== 'checking');
    if (allDone && run.status !== 'queued') {
      await supabase.from('verification_runs').update({ status: 'complete' }).eq('id', runId);
      await log(runId, 'Verification complete');
      run.status = 'complete';
      if (healed) {
        console.log(`[verify/status] Auto-completed run ${runId} after healing stuck claims`);
      } else {
        console.log(`[verify/status] Closing stale verifying run ${runId} — all claims already terminal`);
      }
    }
  }

  // ── Queue advancement: dispatch next pending run when a slot is free ─────
  // Strategy: only the OLDEST LIVE pending run self-promotes when it polls.
  // Dead pending runs (no pending claims — stale from crashed/re-run sessions)
  // are auto-completed first so they don't block the queue.
  if (run.status === 'pending') {
    // Find the oldest pending run that actually has pending claims (live run)
    const { data: pendingRuns } = await supabase
      .from('verification_runs')
      .select('id, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(20)
      .returns<{ id: string; created_at: string }[]>();

    // Clean up dead pending runs ahead in queue:
    // 1. Runs with no active claims (pending/checking), OR
    // 2. Runs stuck in pending for >15 min (abandoned — never dispatched)
    const ABANDONED_PENDING_MS = 5 * 60 * 1000; // 5 min — runs get promoted within ~30s; stuck longer = abandoned
    for (const candidate of (pendingRuns ?? [])) {
      if (candidate.id === runId) break;

      const { count: activeClaimCount } = await supabase
        .from('claims')
        .select('id', { count: 'exact', head: true })
        .eq('verification_run_id', candidate.id)
        .in('status', ['pending', 'checking']);

      const candidateAge = Date.now() - new Date(candidate.created_at ?? 0).getTime();
      const isAbandoned = activeClaimCount === 0 || candidateAge > ABANDONED_PENDING_MS;

      if (isAbandoned) {
        await supabase
          .from('verification_runs')
          .update({ status: 'complete' })
          .eq('id', candidate.id)
          .eq('status', 'pending');
        console.log(`[verify/status] Cleaned up stale pending run ${candidate.id} (age ${Math.round(candidateAge / 1000)}s, activeClaims=${activeClaimCount})`);
      }
    }

    // Re-query to find the true oldest live pending run
    const { data: oldestLive } = await supabase
      .from('verification_runs')
      .select('id')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle<{ id: string }>();

    const isOldest = oldestLive?.id === runId;

    if (isOldest) {
      const freshActiveCount = await countActiveVerifyingRuns();

      if (freshActiveCount < MAX_CONCURRENT_RUNS) {
        const { count: ownPendingClaims } = await supabase
          .from('claims')
          .select('id', { count: 'exact', head: true })
          .eq('verification_run_id', runId)
          .eq('status', 'pending');

        if ((ownPendingClaims ?? 0) > 0) {
          const { data: selfPromoted } = await supabase
            .from('verification_runs')
            .update({ status: 'verifying' })
            .eq('id', runId)
            .eq('status', 'pending')
            .select('id')
            .maybeSingle<{ id: string }>();

          if (selfPromoted) {
            console.log(`[verify/status] Promoting run ${runId} → verifying`);
            run.status = 'verifying';
            await log(runId, 'Queue slot available — browser verification starting');
            dispatchClaimsForRun(runId, origin).catch((e) =>
              console.error('[verify/status] Failed to dispatch run:', e),
            );
          }
        }
      }
    }
  }

  // ── Queue position ────────────────────────────────────────────────────────
  let queuePosition: number | null = null;
  if (run.status === 'pending') {
    // Count only live pending runs created before this one
    const { data: olderRuns } = await supabase
      .from('verification_runs')
      .select('id')
      .eq('status', 'pending')
      .lt('created_at', run.created_at)
      .returns<{ id: string }[]>();

    let liveAhead = 0;
    for (const older of (olderRuns ?? [])) {
      const { count } = await supabase
        .from('claims')
        .select('id', { count: 'exact', head: true })
        .eq('verification_run_id', older.id)
        .in('status', ['pending', 'checking']);
      if ((count ?? 0) > 0) liveAhead++;
    }
    queuePosition = liveAhead + 1;
  }

  return ok({
    run,
    claims,
    logs,
    project: project ?? null,
    queuePosition,
  });
});
