import { NextRequest } from 'next/server';
import { extractClaimsFromText } from '@/lib/llm';
import { fetchXProfileText } from '@/lib/x-scraper';
import { supabase } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { ok, err, withErrorHandler } from '@/lib/api-helpers';
import type { DbProject, DbClaim } from '@/lib/db-types';

export const POST = withErrorHandler(async (req: Request) => {
  const body = await (req as NextRequest).json().catch(() => ({}));
  const { projectId, websiteText, runId } = body ?? {};

  if (!projectId || typeof projectId !== 'string') {
    return err('projectId is required');
  }
  if (!websiteText || typeof websiteText !== 'string' || websiteText.length < 50) {
    return err('websiteText is required and must be at least 50 characters');
  }

  // Fetch the project (name + twitter handle)
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('name, twitter')
    .eq('id', projectId)
    .single<Pick<DbProject, 'name' | 'twitter'>>();

  if (projectError || !project) {
    return err('Project not found', 404);
  }

  if (runId) await log(runId, 'Extracting product claims with AI...');

  // Scrape X profile in parallel (non-blocking — failure is silently ignored)
  let xText = '';
  if (project.twitter) {
    if (runId) await log(runId, `Scraping X profile @${project.twitter}...`);
    console.log(`[claims/extract] Fetching X profile for @${project.twitter}`);
    xText = await fetchXProfileText(project.twitter).catch(() => '');
    if (xText) {
      console.log(`[claims/extract] X profile text: ${xText.length} chars`);
      if (runId) await log(runId, `X profile scraped — ${xText.length} chars`);
    } else {
      console.log('[claims/extract] X profile returned no content (login wall or empty)');
      if (runId) await log(runId, 'X profile unavailable — using website only');
    }
  }

  // Run LLM extraction with combined context
  const extracted = await extractClaimsFromText(project.name, websiteText, xText);

  if (extracted.length === 0) {
    if (runId) await log(runId, 'No verifiable product claims found on website');
    return ok({ claims: [], count: 0 });
  }

  // Persist claims to Supabase
  const rows = extracted.map((c) => ({
    project_id:            projectId,
    verification_run_id:   runId ?? null,
    claim:                 c.claim,
    pass_condition:        c.pass_condition,
    feature_type:          c.feature_type,
    surface:               c.surface,
    verification_strategy: c.verification_strategy,
    status:                'pending' as const,
  }));

  const { data: savedClaims, error: insertError } = await supabase
    .from('claims')
    .insert(rows)
    .select<string, DbClaim>();

  if (insertError) {
    console.error('[claims/extract] Insert error:', insertError.message);
    return err('Failed to save claims to database', 500);
  }

  if (runId) {
    await log(runId, `${extracted.length} claim${extracted.length === 1 ? '' : 's'} extracted`);
  }

  // Sync claims_extracted count on the run
  if (runId) {
    await supabase
      .from('verification_runs')
      .update({ claims_extracted: extracted.length })
      .eq('id', runId);
  }

  return ok({
    claims:    savedClaims ?? [],
    count:     extracted.length,
    xScraped:  xText.length > 0,
    xChars:    xText.length,
    twitter:   project.twitter ?? null,
  });
});
