import { supabase } from '@/lib/supabase';
import { ok, withErrorHandler } from '@/lib/api-helpers';
import type { DbProject, DbVerificationRun, DbClaim } from '@/lib/db-types';
import type { RecentVerification, JobStatus } from '@/lib/types';

const LIMIT = 30;

function runStatusToJobStatus(status: DbVerificationRun['status']): JobStatus {
  if (status === 'complete') return 'complete';
  if (status === 'failed')   return 'failed';
  return 'in_progress';
}

function elapsedLabel(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  const s  = Math.round(ms / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

export const GET = withErrorHandler(async () => {
  console.log('[runs/recent] Fetching recent verification runs');

  const { data: runs, error: runsErr } = await supabase
    .from('verification_runs')
    .select('*, projects(*)')
    .order('created_at', { ascending: false })
    .limit(LIMIT);

  if (runsErr) {
    console.error('[runs/recent] Query error:', runsErr.message);
    return ok({ runs: [] });
  }

  if (!runs?.length) {
    return ok({ runs: [] });
  }

  // Deduplicate: keep only the most recent run per project_id.
  // Since runs are already sorted by created_at DESC, the first occurrence
  // of each project_id is the most recent one.
  const seenProjects = new Set<string>();
  const dedupedRuns = runs.filter((r) => {
    const pid = (r as DbVerificationRun).project_id;
    if (seenProjects.has(pid)) return false;
    seenProjects.add(pid);
    return true;
  });

  const runIds = dedupedRuns.map((r) => r.id as string);

  const { data: claims } = await supabase
    .from('claims')
    .select('verification_run_id, status')
    .in('verification_run_id', runIds)
    .returns<Pick<DbClaim, 'verification_run_id' | 'status'>[]>();

  const claimsByRun: Record<string, Pick<DbClaim, 'verification_run_id' | 'status'>[]> = {};
  for (const c of claims ?? []) {
    if (!c.verification_run_id) continue;
    (claimsByRun[c.verification_run_id] ??= []).push(c);
  }

  const result: RecentVerification[] = dedupedRuns.map((row) => {
    const run     = row as DbVerificationRun;
    const project = (row as unknown as { projects: DbProject }).projects;
    const runClaims = claimsByRun[run.id] ?? [];

    return {
      id:            run.id,
      project: {
        name:            project?.name            ?? 'Unknown',
        ticker:          project?.symbol          ?? '???',
        logoInitial:     project?.name?.[0]?.toUpperCase() ?? '?',
        website:         project?.website         ?? '',
        xHandle:         project?.twitter         ?? '',
        contractAddress: project?.contract_address ?? '',
      },
      status:         runStatusToJobStatus(run.status),
      claimsTotal:    runClaims.length,
      claimsVerified: runClaims.filter((c) => c.status === 'verified').length,
      estTime:        `~${elapsedLabel(run.created_at)}`,
    };
  });

  console.log(`[runs/recent] Returning ${result.length} runs (deduped from ${runs.length})`);
  return ok({ runs: result });
});
