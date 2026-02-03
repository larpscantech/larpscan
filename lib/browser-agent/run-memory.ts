import type { AgentObservation } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// RunMemory — accumulated knowledge from Plan A observations.
//
// Built after Plan A executes and passed into replanWorkflow (Plan B) so the
// recovery planner knows what was already discovered: which routes were visited,
// whether the wallet connected, whether an auth gate was present, etc.
//
// This eliminates the "start from scratch" behaviour in Plan B where the agent
// re-tries routes it already knows are dead ends.
// ─────────────────────────────────────────────────────────────────────────────

export interface RunMemory {
  /** Internal routes visited during this claim's Plan A */
  siteNavRoutes: string[];
  /** True if any step encountered an auth/login wall */
  authRequired: boolean;
  /** True if the investigation wallet successfully connected */
  walletConnectionWorked: boolean;
  /** Feature types confirmed working in this run */
  verifiedFeatureTypes: string[];
  /** Routes visited but produced no observable evidence */
  failedSurfaces: string[];
}

export function createRunMemory(): RunMemory {
  return {
    siteNavRoutes:         [],
    authRequired:          false,
    walletConnectionWorked: false,
    verifiedFeatureTypes:  [],
    failedSurfaces:        [],
  };
}

export function updateRunMemory(
  memory:        RunMemory,
  observations:  AgentObservation[],
  featureType:   string,
  walletConnected: boolean,
  verdict?:      string,
): void {
  for (const obs of observations) {
    if (obs.urlChanged && obs.url) {
      try {
        const p = new URL(obs.url).pathname;
        if (p && p !== '/' && !memory.siteNavRoutes.includes(p)) {
          memory.siteNavRoutes.push(p);
        }
      } catch { /* malformed URL — ignore */ }
    }
    if (obs.blockerDetected === 'auth_required') {
      memory.authRequired = true;
    }
    // Track surfaces where ALL steps were noops (nothing found there)
    if (obs.isNoop && obs.url) {
      try {
        const p = new URL(obs.url).pathname;
        if (p && p !== '/' && !memory.failedSurfaces.includes(p)) {
          memory.failedSurfaces.push(p);
        }
      } catch { /* ignore */ }
    }
  }

  if (walletConnected) {
    memory.walletConnectionWorked = true;
  }

  if (verdict === 'verified' && !memory.verifiedFeatureTypes.includes(featureType)) {
    memory.verifiedFeatureTypes.push(featureType);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Formats RunMemory as a compact context block for injection into LLM prompts.
// Returns an empty string when there is nothing useful to report.
// ─────────────────────────────────────────────────────────────────────────────

export function formatRunMemoryContext(memory: RunMemory): string {
  const hasAny =
    memory.siteNavRoutes.length > 0 ||
    memory.authRequired ||
    memory.walletConnectionWorked ||
    memory.verifiedFeatureTypes.length > 0 ||
    memory.failedSurfaces.length > 0;

  if (!hasAny) return '';

  const lines: string[] = ['RUN CONTEXT (knowledge from Plan A on this same site):'];

  if (memory.siteNavRoutes.length > 0) {
    lines.push(`- Routes already visited: ${memory.siteNavRoutes.join(', ')}`);
  }
  if (memory.authRequired) {
    lines.push('- Auth/login wall was encountered — plan steps that work around it or use the wallet');
  }
  if (memory.walletConnectionWorked) {
    lines.push('- Wallet connection previously worked on this site — the mock wallet is functional');
  }
  if (memory.verifiedFeatureTypes.length > 0) {
    lines.push(`- Features confirmed working: ${memory.verifiedFeatureTypes.join(', ')}`);
  }
  if (memory.failedSurfaces.length > 0) {
    // Remove from failedSurfaces any that are also in siteNavRoutes with evidence
    const trulyDead = memory.failedSurfaces.filter(
      (s) => !memory.verifiedFeatureTypes.length || memory.siteNavRoutes.includes(s),
    );
    if (trulyDead.length > 0) {
      lines.push(`- Dead surfaces (visited, no evidence found): ${trulyDead.join(', ')}`);
    }
  }

  return lines.join('\n');
}
