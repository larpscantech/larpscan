import { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import { ok, withErrorHandler } from '@/lib/api-helpers';
import type { DbProject, DbVerificationRun } from '@/lib/db-types';

export const runtime = 'nodejs';

/**
 * Lightweight read-only endpoint: checks whether a CA currently has an
 * active in-progress run or a recent completed run.
 *
 * No side-effects — no run creation, no discovery, no scraping.
 * Called by the dashboard's debounced input handler to auto-join active runs
 * and by the on-mount URL-restore logic to reconnect after a refresh.
 *
 * GET /api/verify/active?ca=0x...
 *
 * Response:
 *   hasActiveRun: true  → a run is currently verifying; supply runId to join
 *   hasActiveRun: false + hasCompletedRun: true → cached result available
 *   hasActiveRun: false + hasCompletedRun: false → no run exists yet
 */

const STALE_RUN_MS = 8 * 60 * 1000;
const ACTIVE_STATUSES = ['pending', 'verifying', 'extracting', 'analyzing'];

export const GET = withErrorHandler(async (req: Request) => {
  const ca = new URL((req as NextRequest).url).searchParams.get('ca')?.trim() ?? '';

  if (!ca || !/^0x[0-9a-fA-F]{40,}$/i.test(ca)) {
    return ok({ hasActiveRun: false, hasCompletedRun: false, runId: null, runStatus: null });
  }

  // ── Look up project by contract address ───────────────────────────────────
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('contract_address', ca.toLowerCase())
    .maybeSingle<Pick<DbProject, 'id'>>();

  if (!project) {
    return ok({ hasActiveRun: false, hasCompletedRun: false, runId: null, runStatus: null });
  }

  // ── Check for active in-progress run ─────────────────────────────────────
  const { data: activeRun } = await supabase
    .from('verification_runs')
    .select('id, status, created_at')
    .eq('project_id', project.id)
    .in('status', ACTIVE_STATUSES)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<Pick<DbVerificationRun, 'id' | 'status' | 'created_at'>>();

  if (activeRun) {
    const age = Date.now() - new Date(activeRun.created_at).getTime();
    if (age < STALE_RUN_MS) {
      return ok({
        hasActiveRun:    true,
        hasCompletedRun: false,
        runId:           activeRun.id,
        runStatus:       activeRun.status,
      });
    }
  }

  // ── Check for most recent completed run ───────────────────────────────────
  const { data: completedRun } = await supabase
    .from('verification_runs')
    .select('id, status, created_at')
    .eq('project_id', project.id)
    .eq('status', 'complete')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<Pick<DbVerificationRun, 'id' | 'status' | 'created_at'>>();

  if (completedRun) {
    return ok({
      hasActiveRun:    false,
      hasCompletedRun: true,
      runId:           completedRun.id,
      runStatus:       'complete',
    });
  }

  return ok({ hasActiveRun: false, hasCompletedRun: false, runId: null, runStatus: null });
});
