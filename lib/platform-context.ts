// ─────────────────────────────────────────────────────────────────────────────
// PlatformContext — run-level knowledge shared across claims in the same run.
//
// When claim 1 discovers that a platform is fully auth-gated (requires Telegram
// or Discord sign-in) or blocks bots, claims 2 and 3 should not waste 90 seconds
// repeating the same discovery. This module caches that insight so subsequent
// claims can fast-track to UNTESTABLE without launching a browser session.
//
// Implementation note:
//  - Module-level Map — works perfectly on local dev (same Node.js process).
//  - On Vercel serverless, each invocation is isolated; the cache may be empty
//    for the second/third claim. This is acceptable — the system degrades
//    gracefully (claims run normally rather than fast-tracking).
//  - TTL: entries expire after 20 minutes to prevent stale state.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlatformContext {
  /** Blockers encountered by any previous claim in this run */
  confirmedBlockers: Set<string>;
  /** True when a claim already confirmed the site is fully bot-blocked */
  botBlocked: boolean;
  /** True when every completed claim returned auth_required or wallet_only_gate */
  platformAuthGated: boolean;
  /** Number of claims completed for this run */
  completedClaims: number;
  /** Timestamp of last update (ms since epoch) */
  updatedAt: number;
}

const CACHE = new Map<string, PlatformContext>();
const TTL_MS = 20 * 60 * 1000; // 20 minutes

function getOrCreate(runId: string): PlatformContext {
  const now = Date.now();
  let ctx = CACHE.get(runId);
  if (!ctx || now - ctx.updatedAt > TTL_MS) {
    ctx = {
      confirmedBlockers:  new Set(),
      botBlocked:         false,
      platformAuthGated:  false,
      completedClaims:    0,
      updatedAt:          now,
    };
    CACHE.set(runId, ctx);
  }
  return ctx;
}

/** Called after a claim completes — records platform-level insights. */
export function recordClaimResult(
  runId:     string,
  blockers:  string[],
  verdict:   string,
): void {
  const ctx = getOrCreate(runId);
  ctx.completedClaims++;
  ctx.updatedAt = Date.now();
  for (const b of blockers) ctx.confirmedBlockers.add(b);
  if (blockers.includes('bot_protection')) ctx.botBlocked = true;
  // After 2+ claims all returning untestable due to auth/wallet gates, mark platform as auth-gated
  if (
    (verdict === 'untestable') &&
    (blockers.includes('auth_required') || blockers.includes('wallet_only_gate')) &&
    ctx.completedClaims >= 1
  ) {
    ctx.platformAuthGated = true;
  }
}

/**
 * Returns a fast-track verdict if the platform context indicates this claim
 * will almost certainly be UNTESTABLE without running a browser session.
 * Returns null if the claim should proceed normally.
 */
export function getFastTrackVerdict(
  runId: string,
): { verdict: 'untestable'; reason: string } | null {
  const ctx = CACHE.get(runId);
  if (!ctx) return null;
  if (Date.now() - ctx.updatedAt > TTL_MS) return null;

  if (ctx.botBlocked) {
    return {
      verdict: 'untestable',
      reason:  'Platform is bot-blocked — previous claim confirmed bot_protection blocker',
    };
  }
  if (ctx.platformAuthGated && ctx.completedClaims >= 2) {
    return {
      verdict: 'untestable',
      reason:  'Platform requires authentication — previous claims confirmed auth/wallet gate across the platform',
    };
  }
  return null;
}

/** Clears stale entries (housekeeping — safe to call periodically). */
export function pruneCache(): void {
  const now = Date.now();
  for (const [id, ctx] of CACHE) {
    if (now - ctx.updatedAt > TTL_MS) CACHE.delete(id);
  }
}
