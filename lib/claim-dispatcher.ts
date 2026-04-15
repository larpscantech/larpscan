/**
 * lib/claim-dispatcher.ts
 *
 * Shared function for dispatching verification claim workers.
 * Used by both /api/verify/run (immediate dispatch) and
 * /api/verify/status (queue-based dispatch when a slot opens up).
 *
 * Uses node:http/https instead of fetch() to avoid undici's headersTimeout
 * killing long-running claim workers before they finish.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { supabase } from './supabase';
import { log } from './logger';
import type { DbClaim } from './db-types';

/** One Browserless account → one run at a time keeps concurrent sessions inside plan limits. */
export const MAX_CONCURRENT_RUNS = 1;

/**
 * How long a run may stay in `verifying` status before it's considered stale
 * for queue purposes. A crashed server could leave a run stuck in `verifying`.
 * Set generously: max claim duration (10 min) + recording/upload overhead.
 */
const STALE_VERIFYING_MS = 20 * 60 * 1000; // 20 min

/** Returns the number of non-stale runs currently in `verifying` state. */
export async function countActiveVerifyingRuns(): Promise<number> {
  const since = new Date(Date.now() - STALE_VERIFYING_MS).toISOString();
  const { count } = await supabase
    .from('verification_runs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'verifying')
    .gte('created_at', since);
  return count ?? 0;
}

/**
 * Fire-and-forget dispatch of all pending claims for a run.
 * The run must already be in `verifying` state before calling this.
 */
export async function dispatchClaimsForRun(runId: string, origin: string): Promise<void> {
  const { data: pendingClaims } = await supabase
    .from('claims')
    .select('*')
    .eq('verification_run_id', runId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .returns<DbClaim[]>();

  const claims = pendingClaims ?? [];
  if (claims.length === 0) {
    console.log(`[claim-dispatcher] No pending claims for run ${runId}`);
    return;
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  for (let i = 0; i < claims.length; i++) {
    if (i > 0) await sleep(3_000); // stagger to avoid Browserless connection storms

    const claim = claims[i];

    // Atomically claim the row (prevents duplicate workers if called twice)
    const { data: staked } = await supabase
      .from('claims')
      .update({ status: 'checking' })
      .eq('id', claim.id)
      .eq('status', 'pending')
      .select('id')
      .single<{ id: string }>();

    if (!staked) {
      console.log(`[claim-dispatcher] Claim ${claim.id} already taken — skipping`);
      continue;
    }

    await log(runId, `Dispatching claim: ${claim.claim}`);

    const payload = JSON.stringify({ runId, claimId: claim.id });
    const claimUrl = new URL(`${origin}/api/verify/claim`);
    const requestFn = claimUrl.protocol === 'https:' ? httpsRequest : httpRequest;

    const req = requestFn({
      hostname: claimUrl.hostname,
      port:     claimUrl.port || (claimUrl.protocol === 'https:' ? 443 : 80),
      path:     claimUrl.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    });

    req.on('error', (e) =>
      console.error(`[claim-dispatcher] Fire-and-forget claim ${claim.id} error:`, e),
    );
    req.on('response', (res) => {
      res.resume();
      res.on('error', () => {});
    });

    req.write(payload);
    req.end();
  }

  console.log(`[claim-dispatcher] Dispatched ${claims.length} claim(s) for run ${runId}`);
}
