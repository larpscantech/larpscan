import { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { ok, err, withErrorHandler } from '@/lib/api-helpers';
import type { DbVerificationRun, DbAgentLog, DbClaimWithEvidence } from '@/lib/db-types';

const STUCK_CHECKING_MS = 5.5 * 60 * 1000; // 5.5 min — just above Vercel's 300s hard kill

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

  // Auto-heal claims stuck in "checking" (Vercel killed the worker at the
  // 300s hard limit). Then close the run whenever ALL claims are terminal,
  // regardless of whether healing happened this cycle or a previous one.
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

    // Close the run whenever every claim is in a terminal state — regardless
    // of whether healing happened this cycle or was done in a previous poll.
    const allDone = claims.every((c) => c.status !== 'pending' && c.status !== 'checking');
    if (allDone) {
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

  return ok({
    run,
    claims,
    logs,
  });
});
