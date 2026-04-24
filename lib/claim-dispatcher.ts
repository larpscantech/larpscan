/**
 * lib/claim-dispatcher.ts
 *
 * Shared function for dispatching verification claim workers.
 * Used by both /api/verify/run (immediate dispatch) and
 * /api/verify/status (queue-based dispatch when a slot opens up).
 *
 * Uses a "daisy-chain" pattern: each completed claim triggers the next one
 * via the claim route handler rather than a sequential loop in this module.
 * This is more robust than a sequential loop because it doesn't rely on an
 * HTTP connection staying alive (hot-reloads can ECONNRESET long-running
 * requests, causing a sequential loop to race ahead prematurely).
 *
 * Flow:
 *   dispatchClaimsForRun()  →  fire-and-forget HTTP POST for first pending claim
 *   claim route (first)     →  runs to completion → calls dispatchNextClaim()
 *   dispatchNextClaim()     →  fire-and-forget HTTP POST for next pending claim
 *   claim route (second)    →  runs to completion → calls dispatchNextClaim()
 *   ...
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
 * Kick off sequential claim processing for a run.
 *
 * Dispatches ONLY THE FIRST pending claim via a fire-and-forget HTTP POST.
 * When that claim completes, its route handler calls `dispatchNextClaim`
 * which fires the next pending claim, and so on.  This daisy-chain ensures
 * strict serial execution without relying on a long-lived HTTP connection.
 *
 * If a claim is already 'checking' for this run, we skip dispatch — the
 * daisy-chain is already in progress.
 */
export async function dispatchClaimsForRun(runId: string, origin: string): Promise<void> {
  // Guard: if any claim is already in 'checking' state, the daisy-chain is
  // already running — don't start a second chain.
  const { count: checkingCount } = await supabase
    .from('claims')
    .select('id', { count: 'exact', head: true })
    .eq('verification_run_id', runId)
    .eq('status', 'checking');

  if ((checkingCount ?? 0) > 0) {
    console.log(`[claim-dispatcher] Claim already checking for run ${runId} — skipping duplicate dispatch`);
    return;
  }

  await dispatchNextClaim(runId, origin);
}

/**
 * Feature types that should run first — they need a fresh, unloaded Browserless
 * session.  WALLET_FLOW and TOKEN_CREATION both open heavy SPAs and spawn many
 * CDP evaluate calls; running them while a previous session is still encoding
 * video / releasing memory causes zombie-evaluate queue build-up that can
 * consume the entire 450 s session budget before the form is even reached.
 */
const PRIORITY_FEATURE_TYPES = ['WALLET_FLOW', 'TOKEN_CREATION'];

/**
 * Dispatch the next pending claim for a run (fire-and-forget).
 * Called by dispatchClaimsForRun (initial) and by the claim route (daisy-chain).
 *
 * @param cooldownMs  Optional delay before firing the HTTP POST.  Pass > 0 for
 *                    all but the first claim to give Browserless time to encode
 *                    the previous session's video and free memory.
 */
export async function dispatchNextClaim(runId: string, origin: string, cooldownMs = 0): Promise<void> {
  // Optional cooldown — lets Browserless finish encoding and GC between sessions.
  // Does NOT delay the previous claim's HTTP response (this function is called
  // fire-and-forget from maybeCompleteRun in the claim route).
  if (cooldownMs > 0) {
    console.log(`[claim-dispatcher] Cooling down ${cooldownMs / 1_000}s before next claim (Browserless recovery)…`);
    await new Promise<void>((r) => setTimeout(r, cooldownMs));
  }

  // Fetch ALL pending claims so we can priority-sort before picking one.
  // WALLET_FLOW / TOKEN_CREATION are dispatched first: they require the freshest
  // Browserless session (no zombie CDP evaluates from prior sessions).
  const { data: allPending } = await supabase
    .from('claims')
    .select('*')
    .eq('verification_run_id', runId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .returns<DbClaim[]>();

  if (!allPending?.length) {
    console.log(`[claim-dispatcher] No more pending claims for run ${runId}`);
    return;
  }

  // Sort: priority features first, then original creation order.
  const sorted = [...allPending].sort((a, b) => {
    const aPri = PRIORITY_FEATURE_TYPES.includes(a.feature_type ?? '') ? 0 : 1;
    const bPri = PRIORITY_FEATURE_TYPES.includes(b.feature_type ?? '') ? 0 : 1;
    return aPri - bPri;
  });

  const claim = sorted[0];
  if (!claim) {
    console.log(`[claim-dispatcher] No more pending claims for run ${runId}`);
    return;
  }

  // Atomically stake the claim (prevents duplicate workers)
  const { data: staked } = await supabase
    .from('claims')
    .update({ status: 'checking' })
    .eq('id', claim.id)
    .eq('status', 'pending')
    .select('id')
    .single<{ id: string }>();

  if (!staked) {
    console.log(`[claim-dispatcher] Claim ${claim.id} already taken — skipping`);
    return;
  }

  await log(runId, `Dispatching claim: ${claim.claim.slice(0, 60)}`);
  console.log(`[claim-dispatcher] Firing claim ${claim.id} for run ${runId}`);

  // Fire-and-forget: don't await the HTTP response.  The daisy-chain continues
  // when the claim route calls dispatchNextClaim after it finishes.
  fireClaimRequest(claim.id, runId, origin);
}

/** Send a fire-and-forget HTTP POST to the claim route. */
function fireClaimRequest(claimId: string, runId: string, origin: string): void {
  const payload   = JSON.stringify({ runId, claimId });
  const claimUrl  = new URL(`${origin}/api/verify/claim`);
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

  req.on('error', (e) => {
    console.error(`[claim-dispatcher] HTTP error for claim ${claimId}:`, e);
  });

  req.on('response', (res) => {
    res.resume(); // drain the response body to free the socket
    res.on('end', () => {
      console.log(`[claim-dispatcher] Claim ${claimId} HTTP response received`);
    });
  });

  req.write(payload);
  req.end();
}
