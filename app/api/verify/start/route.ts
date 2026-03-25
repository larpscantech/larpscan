import { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import { logBatch } from '@/lib/logger';
import { ok, err, withErrorHandler } from '@/lib/api-helpers';
import type { DbVerificationRun } from '@/lib/db-types';

export const POST = withErrorHandler(async (req: Request) => {
  const body = await (req as NextRequest).json().catch(() => ({}));
  const projectId = (body?.projectId ?? '').trim();
  const forceReverify = Boolean(body?.forceReverify);

  if (!projectId) {
    return err('projectId is required');
  }

  // Confirm the project exists
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id, name, website')
    .eq('id', projectId)
    .single<{ id: string; name: string; website: string | null }>();

  if (projectError || !project) {
    return err('Project not found', 404);
  }

  // Reuse most recent completed run unless forceReverify is enabled
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
      return ok({ runId: existingRun.id, run: existingRun, reused: true });
    }
  }

  // Create the verification run
  const { data: run, error: runError } = await supabase
    .from('verification_runs')
    .insert({ project_id: projectId, status: 'pending' })
    .select()
    .single<DbVerificationRun>();

  if (runError || !run) {
    console.error('[verify/start] Run creation error:', runError?.message);
    return err('Failed to create verification run', 500);
  }

  // Emit initial pipeline logs
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
