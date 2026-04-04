import { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { ok, err, withErrorHandler } from '@/lib/api-helpers';
import type { DbVerificationRun, DbAgentLog, DbClaimWithEvidence } from '@/lib/db-types';

const STUCK_CHECKING_MS = 7 * 60 * 1000;  // 7 min

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

  // Auto-heal only claims that actually STARTED running and then got stuck in
  // "checking". Pending claims are now expected to wait their turn because the
  // pipeline dispatches one claim at a time for consistency.
  if (run.status !== 'complete' && run.status !== 'failed') {
    const now = Date.now();
    let healed = false;
    const startTimes = claimStartTimes(logs);

    for (const claim of claims) {
      const startTs = startTimes.get(claim.id) ?? new Date(claim.created_at).getTime();
      const age = now - startTs;
      const stuckChecking = claim.status === 'checking' && age > STUCK_CHECKING_MS;

      if (stuckChecking) {
        console.warn(`[verify/status] Auto-healing stuck claim ${claim.id} (${claim.status} for ${Math.round(age / 1000)}s)`);
        await supabase.from('claims').update({ status: 'failed' }).eq('id', claim.id);
        await log(runId, `Claim timed out in ${claim.status} state — marking as failed`);
        claim.status = 'failed';
        healed = true;
      }
    }

    if (healed) {
      const allDone = claims.every((c) => c.status !== 'pending' && c.status !== 'checking');
      if (allDone) {
        await supabase.from('verification_runs').update({ status: 'complete' }).eq('id', runId);
        await log(runId, 'Verification complete (some claims timed out)');
        run.status = 'complete';
        console.log(`[verify/status] Auto-completed run ${runId} after healing stuck claims`);
      }
    }

    const hasChecking = claims.some((c) => c.status === 'checking');
    const hasPending  = claims.some((c) => c.status === 'pending');
    if (run.status !== 'complete' && !hasChecking && hasPending) {
      const origin = new URL((req as NextRequest).url).origin;
      fetch(`${origin}/api/verify/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      }).catch(() => {});
    }
  }

  return ok({
    run,
    claims,
    logs,
  });
});
