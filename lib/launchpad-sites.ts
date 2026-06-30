/**
 * Solana memecoin launchpads that share similar create/trade UI flows.
 */

import { isPumpFunSite } from './pump-fun-onchain';

function matchHost(website: string, ...hosts: string[]): boolean {
  try {
    const h = new URL(
      website.startsWith('http') ? website : `https://${website}`,
    ).hostname.replace(/^www\./, '');
    return hosts.some((m) => h === m || h.endsWith(`.${m}`));
  } catch {
    return hosts.some((m) => new RegExp(m.replace('.', '\\.'), 'i').test(website));
  }
}

export function isBagsFmSite(website: string): boolean {
  return matchHost(website, 'bags.fm');
}

export function isBonkFunSite(website: string): boolean {
  return matchHost(website, 'bonk.fun', 'letsbonk.fun');
}

export function isLaunchpadSite(website: string): boolean {
  return isPumpFunSite(website) || isBagsFmSite(website) || isBonkFunSite(website);
}

/** Random short suffix so each test run produces a distinct token name. */
function runSuffix(): string {
  return (Date.now() % 10000).toString().padStart(4, '0');
}

/**
 * Direct create URL — agent lands on the form, not the homepage feed.
 * For sites that accept intent/prefill params the URL passes generic token
 * metadata so the form is pre-filled without hardcoding any brand names.
 */
export function getLaunchpadCreateUrl(baseUrl: string, surface?: string): string {
  const origin = baseUrl.replace(/\/$/, '');
  const sfx    = runSuffix();

  if (isBagsFmSite(baseUrl)) {
    const params = new URLSearchParams({
      intent:      'true',
      name:        `TestToken${sfx}`,
      symbol:      `T${sfx.slice(-3)}`,
      description: 'Test token for verification',
    });
    return `${origin}/launch?${params.toString()}`;
  }

  if (isBonkFunSite(baseUrl)) {
    return `${origin}/create`;
  }

  if (isPumpFunSite(baseUrl)) {
    const path = surface?.includes('create') || surface?.includes('launch') ? surface : '/create';
    return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
  }

  return origin;
}

/**
 * Sites that can fall back to a server-side on-chain program create when the
 * browser UI can't complete wallet authentication.  Both pump.fun and bonk.fun
 * (letsbonk.fun) share the same Pump bonding-curve Solana program so the same
 * SDK call works for both.
 */
export function supportsProgramCreateFallback(website: string): boolean {
  return isPumpFunSite(website) || isBonkFunSite(website);
}

export function isLaunchpadTradeClaim(claim: string): boolean {
  return /\b(trade|buy|sell|swap)\b/i.test(claim) &&
    /\b(coin|token|memecoin|listed)\b/i.test(claim);
}
