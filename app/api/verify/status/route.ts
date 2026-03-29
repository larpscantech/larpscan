import { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { ok, err, withErrorHandler } from '@/lib/api-helpers';
import type { DbVerificationRun, DbAgentLog, DbClaimWithEvidence } from '@/lib/db-types';

const STUCK_PENDING_MS  = 5 * 60 * 1000;  // 5 min
const STUCK_CHECKING_MS = 7 * 60 * 1000;  // 7 min

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

  // Auto-heal stuck claims: if any claim has been pending/checking for too long,
  // the Lambda likely crashed. Mark them failed so the run can complete.
  // This runs on every poll, catching cases where all claim workers died
  // and nobody called maybeCompleteRun.
  if (run.status !== 'complete' && run.status !== 'failed') {
    const now = Date.now();
    let healed = false;

    for (const claim of claims) {
      const age = now - new Date(claim.created_at).getTime();
      const stuckPending  = claim.status === 'pending'  && age > STUCK_PENDING_MS;
      const stuckChecking = claim.status === 'checking' && age > STUCK_CHECKING_MS;

      if (stuckPending || stuckChecking) {
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
  }

  return ok({
    run,
    claims,
    logs: logsResult.data ?? [],
  });
});
