import { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import { log, logBatch } from '@/lib/logger';
import { ok, err, withErrorHandler } from '@/lib/api-helpers';
import { fetchWebsiteText } from '@/lib/scraper';
import { extractClaimsFromText } from '@/lib/llm';
import { fetchXProfileText } from '@/lib/x-scraper';
import type { DbProject, DbVerificationRun, DbClaimWithEvidence } from '@/lib/db-types';

export const runtime = 'nodejs';
export const maxDuration = 120;

const STALE_RUN_MS = 8 * 60 * 1000;

const INFRA_FAILURE_PATTERN = /missing executable|critical failure in launching the browser|preventing any interaction with the site|site-level issue/i;

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

/**
 * Server-side orchestrator: discover → dedup → scrape → extract → create claims.
 *
 * IMPORTANT: This route does NOT dispatch claim workers (fire-and-forget fetch).
 * On Vercel, fire-and-forget fetches are killed when the Lambda returns its response.
 * Instead, the dashboard calls /api/verify/run after this route returns to dispatch
 * claims in a separate Lambda that properly fires off claim workers.
 *
 * Returns:
 *   status: 'complete'  → cached completed run, load instantly
 *   status: 'joined'    → existing in-progress run, poll for results
 *   status: 'started'   → new run created with claims, dashboard must call /api/verify/run
 */
export const POST = withErrorHandler(async (req: Request) => {
  const body = await (req as NextRequest).json().catch(() => ({}));
  const contractAddress = (body?.contractAddress ?? '').trim();
  const forceReverify = Boolean(body?.forceReverify);

  if (!contractAddress) return err('contractAddress is required');

  // ── 1. Discover project ────────────────────────────────────────────────────
  // Never self-fetch on Vercel (Lambda calling itself deadlocks).
  // Use the discover route's logic directly via internal imports.
  const { validateContract, getTokenMetadata } = await import('@/lib/rpc');

  await validateContract(contractAddress);
  const { name: tokenName, symbol: tokenSymbol } = await getTokenMetadata(contractAddress);

  // Check if project already exists in DB with enriched data
  const { data: existingProject } = await supabase
    .from('projects')
    .select('*')
    .eq('contract_address', contractAddress.toLowerCase())
    .maybeSingle<DbProject>();

  let project: DbProject;

  if (existingProject && existingProject.website && !forceReverify) {
    // Already enriched — use cached data
    project = existingProject;
    console.log(`[orchestrate] Using cached project: ${project.name} (${project.website})`);
  } else {
    // Need enrichment — call discover route. This works because discover is a
    // separate Lambda on Vercel (different function, not self-calling).
    const origin = new URL((req as NextRequest).url).origin;
    try {
      const discoverRes = await fetch(`${origin}/api/project/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contractAddress }),
      });
      if (discoverRes.ok) {
        const discoverData = await discoverRes.json() as { project: DbProject };
        project = discoverData.project;
      } else {
        // Enrichment failed — fall back to basic upsert
        const { data: upserted, error: upsertErr } = await supabase
          .from('projects')
          .upsert(
            {
              contract_address: contractAddress.toLowerCase(),
              name: tokenName,
              symbol: tokenSymbol,
              website: existingProject?.website ?? null,
              twitter: existingProject?.twitter ?? null,
              logo_url: existingProject?.logo_url ?? null,
              description: existingProject?.description ?? null,
              chain: 'bsc',
            },
            { onConflict: 'contract_address' },
          )
          .select()
          .single<DbProject>();

        if (upsertErr || !upserted) return err('Failed to save project', 500);
        project = upserted;
      }
    } catch (e) {
      console.warn('[orchestrate] Discover fetch failed, using basic upsert:', e);
      const { data: upserted, error: upsertErr } = await supabase
        .from('projects')
        .upsert(
          {
            contract_address: contractAddress.toLowerCase(),
            name: tokenName,
            symbol: tokenSymbol,
            website: existingProject?.website ?? null,
            twitter: existingProject?.twitter ?? null,
            logo_url: existingProject?.logo_url ?? null,
            description: existingProject?.description ?? null,
            chain: 'bsc',
          },
          { onConflict: 'contract_address' },
        )
        .select()
        .single<DbProject>();

      if (upsertErr || !upserted) return err('Failed to save project', 500);
      project = upserted;
    }
  }

  // ── 2. Check for existing in-progress run ─────────────────────────────────
  if (!forceReverify) {
    const { data: activeRun } = await supabase
      .from('verification_runs')
      .select('*')
      .eq('project_id', project.id)
      .in('status', ['pending', 'verifying', 'extracting', 'analyzing'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<DbVerificationRun>();

    if (activeRun) {
      const age = Date.now() - new Date(activeRun.created_at).getTime();
      if (age < STALE_RUN_MS) {
        console.log(`[orchestrate] Joining existing run ${activeRun.id} (age: ${Math.round(age / 1000)}s)`);
        return ok({ runId: activeRun.id, project, status: 'joined' as const });
      }
      await supabase.from('verification_runs').update({ status: 'failed' }).eq('id', activeRun.id);
    }
  }

  // ── 3. Check for reusable completed run ───────────────────────────────────
  if (!forceReverify) {
    const { data: completedRun } = await supabase
      .from('verification_runs')
      .select('*')
      .eq('project_id', project.id)
      .eq('status', 'complete')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<DbVerificationRun>();

    if (completedRun) {
      const { data: existingClaims } = await supabase
        .from('claims')
        .select('*, evidence_items(*)')
        .eq('verification_run_id', completedRun.id)
        .returns<DbClaimWithEvidence[]>();

      const claims = existingClaims ?? [];
      const hasMeaningful = claims.some((c) => c.status !== 'failed');

      if (claims.length > 0 && hasMeaningful && !hasInfrastructureFailure(claims)) {
        console.log(`[orchestrate] Reusing completed run ${completedRun.id}`);
        return ok({ runId: completedRun.id, project, status: 'complete' as const });
      }
    }
  }

  // ── 4. Create new run ─────────────────────────────────────────────────────
  const { data: run, error: runError } = await supabase
    .from('verification_runs')
    .insert({ project_id: project.id, status: 'pending' })
    .select()
    .single<DbVerificationRun>();

  if (runError || !run) {
    console.error('[orchestrate] Run creation error:', runError?.message);
    return err('Failed to create verification run', 500);
  }

  const runId = run.id;

  await logBatch(runId, [
    'Initializing verification run',
    `Project: ${project.name}`,
    project.website ? `Website: ${project.website}` : 'No website found for this project',
  ]);

  // ── 5. Scrape website ─────────────────────────────────────────────────────
  if (!project.website) {
    await supabase.from('verification_runs').update({ status: 'complete' }).eq('id', runId);
    await log(runId, 'No website on record — automated verification skipped');
    return ok({ runId, project, status: 'started' as const });
  }

  await log(runId, `Extracting website content from ${project.website}...`);

  let websiteText = '';
  try {
    websiteText = await fetchWebsiteText(project.website);
    if (websiteText && websiteText.length >= 50) {
      await log(runId, `Website scraped — ${websiteText.length} chars extracted`);
    } else {
      websiteText = '';
      await log(runId, 'Website scraping returned insufficient content');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Scrape failed';
    console.warn('[orchestrate] Website extraction failed:', msg);
    await log(runId, `Website scraping failed — ${msg}`);
  }

  if (!websiteText) {
    // Scraping failed — try to extract claims from project metadata (description,
    // name, Twitter) if we have enough to work with. Projects like bortagent.xyz
    // block headless browsers but have rich descriptions via CoinGecko / DexScreener.
    const syntheticContent = [
      project.description ?? '',
      project.twitter ? `Twitter: ${project.twitter}` : '',
      project.name ? `Project: ${project.name} (${project.symbol ?? ''})` : '',
    ].filter(Boolean).join('\n').trim();

    if (syntheticContent.length < 50) {
      await supabase.from('verification_runs').update({ status: 'complete' }).eq('id', runId);
      await log(runId, 'No website content or metadata available — 0 claims extracted');
      return ok({ runId, project, status: 'started' as const });
    }

    await log(runId, `Website blocked — falling back to project metadata for claim extraction (${syntheticContent.length} chars)`);
    websiteText = syntheticContent;
  }

  // ── 6. Extract claims via LLM ─────────────────────────────────────────────
  await log(runId, 'Extracting product claims with AI...');

  let xText = '';
  if (project.twitter) {
    await log(runId, `Scraping X profile ${project.twitter}...`);
    xText = await fetchXProfileText(project.twitter).catch(() => '');
    if (xText) {
      await log(runId, `X profile scraped — ${xText.length} chars`);
    } else {
      await log(runId, 'X profile unavailable — using website only');
    }
  }

  const extracted = await extractClaimsFromText(project.name, websiteText, xText, {
    symbol:      project.symbol,
    chain:       project.chain,
    twitter:     project.twitter,
    description: project.description,
  });

  if (extracted.length === 0) {
    await supabase.from('verification_runs').update({ status: 'complete' }).eq('id', runId);
    await log(runId, 'No verifiable product claims found on website');
    return ok({ runId, project, status: 'started' as const });
  }

  const rows = extracted.map((c) => ({
    project_id: project.id,
    verification_run_id: runId,
    claim: c.claim,
    pass_condition: c.pass_condition,
    feature_type: c.feature_type,
    surface: c.surface,
    verification_strategy: c.verification_strategy,
    status: 'pending' as const,
  }));

  const { error: insertError } = await supabase.from('claims').insert(rows);

  if (insertError) {
    console.error('[orchestrate] Claim insert error:', insertError.message);
    return err('Failed to save claims', 500);
  }

  await supabase
    .from('verification_runs')
    .update({ claims_extracted: extracted.length })
    .eq('id', runId);

  await log(runId, `${extracted.length} claim(s) extracted — awaiting verification`);

  // NOTE: We do NOT dispatch claim workers here. On Vercel, fire-and-forget
  // fetches are killed when the Lambda returns. The dashboard calls
  // /api/verify/run in a separate request to dispatch claims properly.

  return ok({ runId, project, status: 'started' as const });
});
