/**
 * verification-graph.ts
 *
 * Maps each FeatureType to a deterministic verification handler.
 * Each handler receives the structured claim + website URL and returns
 * a VerifyClaimResult (same shape as the existing verifier output).
 *
 * Routing entry point: routeVerification()
 */

import type { FeatureType, VerificationStrategy } from './db-types';
import type { VerifyClaimResult } from './verifier';
import { verifyClaim } from './verifier';
import { rpcClient } from './rpc';

// ── Structured claim shape passed through the graph ──────────────────────────

export interface StructuredClaim {
  id:                    string;
  claim:                 string;
  pass_condition:        string;
  feature_type:          FeatureType | null;
  surface:               string | null;
  verification_strategy: VerificationStrategy | null;
}

// ── Strategy implementations ─────────────────────────────────────────────────

/**
 * UI_FEATURE / WALLET_FLOW / DEX_SWAP / TOKEN_CREATION / DATA_DASHBOARD
 * Standard Playwright browser flow — verifyClaim handles everything.
 * The `surface` path is passed in so the analysis session can start there.
 */
async function runBrowserVerification(
  website: string,
  claim: StructuredClaim,
): Promise<VerifyClaimResult> {
  console.log(`[graph] Strategy: browser | surface: ${claim.surface ?? '/'}`);
  return verifyClaim(
    website, claim.claim, claim.pass_condition, claim.id,
    claim.surface ?? '/', claim.feature_type ?? undefined, claim.verification_strategy ?? undefined,
  );
}

/**
 * DEX_SWAP / WALLET_FLOW — browser interaction + on-chain RPC sanity check.
 * Runs the browser flow, then additionally verifies the contract is live on-chain.
 */
async function runBrowserPlusRpc(
  website: string,
  claim: StructuredClaim,
  contractAddress?: string,
): Promise<VerifyClaimResult> {
  console.log(`[graph] Strategy: ui+rpc | surface: ${claim.surface ?? '/'}`);

  const browserResult = await verifyClaim(
    website, claim.claim, claim.pass_condition, claim.id,
    claim.surface ?? '/', claim.feature_type ?? undefined, claim.verification_strategy ?? undefined,
  );

  // If we have a contract address, probe it on-chain as additional evidence
  if (contractAddress) {
    try {
      const code = await rpcClient.getBytecode({
        address: contractAddress as `0x${string}`,
      });
      const rpcLine = code && code.length > 2
        ? `RPC: contract ${contractAddress} is live on-chain (${code.length} bytes)`
        : `RPC: contract ${contractAddress} has no bytecode`;
      browserResult.evidenceSummary += `\n${rpcLine}`;
      console.log(`[graph] ${rpcLine}`);
    } catch (e) {
      console.warn('[graph] RPC probe failed (non-fatal):', e);
    }
  }

  return browserResult;
}

/**
 * API_FEATURE — direct HTTP fetch to the surface endpoint.
 * No Playwright, just a plain request + response inspection.
 */
async function runApiCheck(
  website: string,
  claim: StructuredClaim,
): Promise<VerifyClaimResult> {
  const base    = website.replace(/\/$/, '');
  const surface = claim.surface ?? '/';
  const url     = surface.startsWith('http') ? surface : `${base}${surface}`;

  console.log(`[graph] Strategy: api+fetch | url: ${url}`);

  const probes: string[] = [`GET ${url}`];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'Accept': 'application/json, text/plain, */*' },
    }).finally(() => clearTimeout(timer));

    probes.push(`HTTP ${res.status} ${res.statusText}`);

    const contentType = res.headers.get('content-type') ?? '';
    probes.push(`Content-Type: ${contentType}`);

    if (res.ok) {
      const body = await res.text();
      const preview = body.slice(0, 500).replace(/\s+/g, ' ');
      probes.push(`Response preview: ${preview}`);

      const isJson = contentType.includes('application/json') || body.trim().startsWith('{') || body.trim().startsWith('[');
      if (isJson) {
        probes.push('Response is valid JSON — API endpoint is live');
      }
    } else {
      probes.push(`API endpoint returned ${res.status} — may be auth-protected or non-existent`);
    }

    return {
      evidenceSummary: probes.join('\n'),
      siteLoaded:      res.ok,
      blocked:         res.status === 403 || res.status === 401,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    probes.push(`Fetch error: ${msg}`);
    return { evidenceSummary: probes.join('\n'), siteLoaded: false, blocked: false };
  }
}

/**
 * BOT — cannot be automated. Return UNTESTABLE immediately.
 */
async function runBotCheck(_website: string, claim: StructuredClaim): Promise<VerifyClaimResult> {
  console.log('[graph] Strategy: message+bot → UNTESTABLE (automated bot testing not supported)');
  return {
    evidenceSummary: [
      `Claim: ${claim.claim}`,
      'Strategy: message+bot',
      'UNTESTABLE: Bot interactions (Telegram/Discord) cannot be automated in a headless browser environment.',
      'Manual verification required: send a message to the bot and observe the response.',
    ].join('\n'),
    siteLoaded: true,
    blocked:    true, // treated as untestable
  };
}

/**
 * CLI_TOOL — cannot be automated from a browser context. Return UNTESTABLE.
 */
async function runCliCheck(_website: string, claim: StructuredClaim): Promise<VerifyClaimResult> {
  console.log('[graph] Strategy: terminal+cli → UNTESTABLE (CLI tools cannot run in browser context)');
  return {
    evidenceSummary: [
      `Claim: ${claim.claim}`,
      'Strategy: terminal+cli',
      'UNTESTABLE: CLI tool execution cannot be performed in a headless browser environment.',
      'Manual verification required: install and run the tool, observe the output.',
    ].join('\n'),
    siteLoaded: true,
    blocked:    true,
  };
}

// ── Verification graph ────────────────────────────────────────────────────────

type GraphHandler = (
  website: string,
  claim:   StructuredClaim,
  contractAddress?: string,
) => Promise<VerifyClaimResult>;

const verificationGraph: Record<FeatureType, GraphHandler> = {
  UI_FEATURE:      runBrowserVerification,
  DEX_SWAP:        runBrowserPlusRpc,
  TOKEN_CREATION:  runBrowserVerification,
  API_FEATURE:     runApiCheck,
  BOT:             runBotCheck,
  CLI_TOOL:        runCliCheck,
  WALLET_FLOW:     runBrowserPlusRpc,
  DATA_DASHBOARD:  runBrowserVerification,
};

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Routes a structured claim to the correct verification handler.
 * Falls back to the standard browser flow for unknown feature types.
 */
export async function routeVerification(
  website:         string,
  claim:           StructuredClaim,
  contractAddress?: string,
): Promise<VerifyClaimResult> {
  const featureType = claim.feature_type ?? 'UI_FEATURE';
  const handler     = verificationGraph[featureType] ?? runBrowserVerification;

  console.log(
    `[graph] Routing claim "${claim.claim.slice(0, 50)}" ` +
    `→ ${featureType} (${claim.verification_strategy ?? 'ui+browser'})`,
  );

  return handler(website, claim, contractAddress);
}
