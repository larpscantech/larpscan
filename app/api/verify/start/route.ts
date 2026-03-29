import { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import { logBatch } from '@/lib/logger';
import { ok, err, withErrorHandler } from '@/lib/api-helpers';
import type { DbClaimWithEvidence, DbVerificationRun } from '@/lib/db-types';

const INFRA_FAILURE_PATTERN = /missing executable|critical failure in launching the browser|preventing any interaction with the site|site-level issue/i;

const STALE_RUN_MS = 8 * 60 * 1000; // 8 minutes

function hasInfrastructureFailure(claims: DbClaimWithEvidence[]): boolean {
  return claims.some((claim) => {
    if (claim.status !== 'failed') return false;

    return claim.evidence_items.some((item) => {
      const data = item.data;
      if (!data) return false;

      const summary = typeof data.evidenceSummary === 'string' ? data.evidenceSummary : '';
      const reasoning = typeof data.reasoning === 'string' ? data.reasoning : '';
      return INFRA_FAILURE_PATTERN.test(`${summary}\n${reasoning}`);
    });
  });
}

export const POST = withErrorHandler(async (req: Request) => {
  const body = await (req as NextRequest).json().catch(() => ({}));
  const projectId = (body?.projectId ?? '').trim();
  const forceReverify = Boolean(body?.forceReverify);

  if (!projectId) {
    return err('projectId is required');
  }

  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id, name, website')
    .eq('id', projectId)
    .single<{ id: string; name: string; website: string | null }>();

  if (projectError || !project) {
    return err('Project not found', 404);
  }

  // ── Check for an already in-progress run for this project ─────────────────
  // This prevents duplicate runs when multiple users verify the same token
  // or when a user refreshes the page mid-verification.
  if (!forceReverify) {
    const { data: activeRun } = await supabase
      .from('verification_runs')
      .select('*')
      .eq('project_id', projectId)
      .in('status', ['pending', 'verifying', 'extracting', 'analyzing'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<DbVerificationRun>();

    if (activeRun) {
      const age = Date.now() - new Date(activeRun.created_at).getTime();
      if (age < STALE_RUN_MS) {
        console.log(`[verify/start] Joining existing in-progress run ${activeRun.id} (age: ${Math.round(age / 1000)}s)`);
        return ok({ runId: activeRun.id, run: activeRun, reused: false, inProgress: true });
      }
      // Stale run — mark it failed so it doesn't block future runs
      console.warn(`[verify/start] Marking stale run ${activeRun.id} as failed (age: ${Math.round(age / 1000)}s)`);
      await supabase.from('verification_runs').update({ status: 'failed' }).eq('id', activeRun.id);
    }
  }

  // ── Reuse most recent completed run ───────────────────────────────────────
  if (!forceReverify) {
    const { data: existingRun } = await supabase
      .from('verification_runs')
      .select('*')
      .eq('project_id', projectId)
      .eq('status', 'complete')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<DbVerificationRun>();

    if (existingRun) {
      const { data: existingClaims } = await supabase
        .from('claims')
        .select('*, evidence_items(*)')
        .eq('verification_run_id', existingRun.id)
        .returns<DbClaimWithEvidence[]>();

      const claims = existingClaims ?? [];
      const hasMeaningfulOutcome = claims.some((claim) => claim.status !== 'failed');

      if (claims.length > 0 && hasMeaningfulOutcome && !hasInfrastructureFailure(claims)) {
        return ok({ runId: existingRun.id, run: existingRun, reused: true });
      }
    }
  }

  // ── Create a new run ──────────────────────────────────────────────────────
  const { data: run, error: runError } = await supabase
    .from('verification_runs')
    .insert({ project_id: projectId, status: 'pending' })
    .select()
    .single<DbVerificationRun>();

  if (runError || !run) {
    console.error('[verify/start] Run creation error:', runError?.message);
    return err('Failed to create verification run', 500);
  }

  await logBatch(run.id, [
    'Initializing verification run',
    `Project: ${project.name}`,
    project.website
      ? `Website: ${project.website}`
      : 'No website found for this project',
    'Validating contract address',
    'Fetching project metadata',
  ]);

  return ok({ runId: run.id, run, reused: false });
});
