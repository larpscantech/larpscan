import { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import { ok, err, withErrorHandler } from '@/lib/api-helpers';
import type { DbVerificationRun, DbAgentLog, DbClaimWithEvidence } from '@/lib/db-types';

export const GET = withErrorHandler(async (req: Request) => {
  const { searchParams } = new URL((req as NextRequest).url);
  const runId = searchParams.get('runId')?.trim();

  if (!runId) {
    return err('runId query parameter is required');
  }

  // Fetch run, claims, and logs in parallel
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

  return ok({
    run:    runResult.data,
    claims: claimsResult.data ?? [],
    logs:   logsResult.data  ?? [],
  });
});
