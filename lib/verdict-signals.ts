/**
 * verdict-signals.ts
 *
 * Defines VerdictSignals — a typed, structured snapshot of evidence collected
 * during browser verification.  buildSignals() assembles this from the raw
 * executor output so the deterministic verdict rules and the LLM both receive
 * clean, filtered data instead of a flat text blob.
 */

import type { AgentObservation, PageState } from './browser-agent/types';
import type { WalletEvidence } from './verifier';
import { bscScanTxUrl } from './wallet/signer';

// ─────────────────────────────────────────────────────────────────────────────
// Known third-party API patterns to exclude from "own-domain" evidence
// ─────────────────────────────────────────────────────────────────────────────

const THIRD_PARTY_PATTERNS: RegExp[] = [
  // Auth / wallet infra
  /privy\.io/,
  /clerk\.(com|dev)/,
  /auth0\.com/,
  /cognito-idp/,
  /firebase(app|auth)\.com/,
  /supabase\.co/,
  /magic\.link/,
  /walletconnect\.(com|org)/,
  /rainbow\.me/,
  // Analytics / monitoring
  /google-analytics\.com/,
  /googletagmanager\.com/,
  /segment\.io/,
  /mixpanel\.com/,
  /amplitude\.com/,
  /posthog\.com/,
  /hotjar\.com/,
  /heap\.io/,
  // Error tracking / infra
  /sentry\.io/,
  /bugsnag\.com/,
  /datadog/,
  /nr-data\.net/,
  // Chat / support
  /intercom\.io/,
  /crisp\.chat/,
  /zendesk\.com/,
  // CDN / general infra
  /cloudflare\.com/,
  /vercel\.app/,
  /fastly\.net/,
  // Social
  /twitter\.com\/i\//,
  /api\.x\.com/,
];

function isThirdParty(url: string): boolean {
  return THIRD_PARTY_PATTERNS.some((re) => re.test(url));
}

function splitApiCalls(
  calls: string[],
  siteDomain: string,
): { own: string[]; thirdParty: string[] } {
  const own: string[]        = [];
  const thirdParty: string[] = [];

  for (const call of calls) {
    if (isThirdParty(call)) {
      thirdParty.push(call);
    } else if (call.includes(siteDomain)) {
      own.push(call);
    } else {
      // Unknown domain — treat as third-party to be conservative
      thirdParty.push(call);
    }
  }

  return { own, thirdParty };
}

// ─────────────────────────────────────────────────────────────────────────────
// VerdictSignals — structured evidence consumed by Layer 1 and the LLM prompt
// ─────────────────────────────────────────────────────────────────────────────

export interface VerdictSignals {
  /** Whether Session 1 HTTP probe succeeded */
  siteLoaded: boolean;
  /** Whether Session 1 detected Cloudflare / bot protection */
  blocked: boolean;
  /** Whether the agent ended up on a URL that differs from the start URL */
  reachedRelevantSurface: boolean;
  /** Final URL after all steps */
  finalUrl: string;
  /** Did any step cause a URL change */
  routeChanged: boolean;
  /** Did any step open a modal */
  modalOpened: boolean;
  /** Were form fields visible on the final page */
  formAppeared: boolean;
  /** Were enabled (non-disabled) CTAs present on the final page */
  enabledCtaPresent: boolean;
  /** API calls to the site's own domain (strong functional evidence) */
  ownDomainApiCalls: string[];
  /** API calls to auth / analytics / infra providers (weak evidence) */
  thirdPartyApiCalls: string[];
  /** Table column headers visible on the final page */
  tableHeaders: string[];
  /** Chart / data visualisation signals on the final page */
  chartSignals: string[];
  /** BlockerType values encountered across the run */
  blockersEncountered: string[];
  /** Number of steps that produced no observable change */
  noopCount: number;
  /** Total steps executed */
  totalSteps: number;
  /** New headings / section labels that appeared during the run */
  visibleSignals: string[];
  /** True when the configured surface was unreachable and the agent fell back */
  routeFallbackUsed: boolean;
  /** Wallet evidence — present when investigation wallet is configured */
  walletEvidence?: WalletEvidence;
  /** True when eth_sendTransaction returned a tx hash (broadcast, not necessarily success) */
  transactionSubmitted: boolean;
  /** On-chain transaction hash (if a transaction was submitted) */
  transactionHash?: string;
  /** BscScan URL for the transaction */
  transactionExplorerUrl?: string;
  /**
   * After mining: whether execution succeeded. Undefined if no tx or receipt not polled yet.
   * Rule 0 (VERIFIED) requires `success`; `reverted` matches dApp "Transaction failed" UX.
   */
  transactionReceiptStatus?: 'success' | 'reverted' | 'timeout';
  /**
   * Heuristic: final page text looks like inline form validation (e.g. "Please enter…").
   * Prevents Rule 4b/6 from treating an invalid/incomplete form as VERIFIED.
   */
  likelyFormValidationError: boolean;
  /**
   * True when eth_sendTransaction was called regardless of outcome.
   * A tx rejected by the RPC (insufficient funds for gas) never produces a hash
   * but still proves the feature IS functional — the frontend built a valid tx.
   */
  transactionAttempted: boolean;
  /**
   * True when Playwright's 'pageerror' event fired at least once during the run,
   * indicating an unhandled JS exception in the page (React render crash, hydration
   * error, etc.). Used by Rule 1b to distinguish "page crashed" from "feature absent".
   */
  pageJsCrash: boolean;
  /**
   * First JS crash message, if any — included in verdict reasoning so operators
   * can see what broke without reading the full agent logs.
   */
  pageJsCrashMessage?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildSignals
// ─────────────────────────────────────────────────────────────────────────────

export function buildSignals(
  observations:     AgentObservation[],
  finalPageState:   PageState,
  runApiCalls:      string[],
  startUrl:         string,
  siteLoaded:       boolean,
  blocked:          boolean,
  routeFallbackUsed: boolean,
  walletEvidence?:  WalletEvidence,
  txHashes:         string[] = [],
  txReceiptStatus?: 'success' | 'reverted' | 'timeout',
  txAttempted:      boolean = false,
  /** Configured claim surface path (e.g. "/mint"). Used to detect when the
   *  agent started at the right URL so reachedRelevantSurface isn't false. */
  claimSurface?:    string,
  /** True when verifier detected that all Plan B steps were no-ops, indicating
   *  a wallet-only gate. This is emitted as a probe string in verifier.ts and
   *  must be passed explicitly because page-analysis never emits this blocker. */
  walletOnlyGate?:  boolean,
  /** Unhandled JS errors captured by Playwright's page.on('pageerror') during
   *  the run. Used to detect when a feature page crashed (React render error)
   *  so Rule 1b can return FAILED instead of letting the LLM conclude LARP. */
  pageJsErrors:     string[] = [],
): VerdictSignals {
  // Derive the site's own hostname for API call filtering
  let siteDomain = '';
  try { siteDomain = new URL(startUrl).hostname; } catch { /* non-fatal */ }

  // ── API call classification ─────────────────────────────────────────────
  const uniqueCalls = [...new Set(runApiCalls)];
  const { own, thirdParty } = splitApiCalls(uniqueCalls, siteDomain);

  // ── Aggregate observation signals ───────────────────────────────────────
  const modalOpened  = observations.some((o) => o.modalOpened);
  const routeChanged = observations.some((o) => o.urlChanged);
  const noopCount    = observations.filter((o) => o.isNoop).length;
  const totalSteps   = observations.length;

  const allBlockers: string[] = [
    ...finalPageState.blockers as string[],
    ...(observations
      .map((o) => o.blockerDetected)
      .filter((b): b is NonNullable<typeof b> => b != null) as string[]),
  ];

  // wallet_only_gate is emitted as a human-readable probe by verifier.ts
  // when Plan B observations are all no-ops. It is never emitted by page-analysis
  // or detectBlockerFromText, so it never reaches blockersEncountered through the
  // normal path. Accept it as an explicit flag from the caller so Rule 3 and the
  // executor/planner hard-stops become reachable.
  if (walletOnlyGate) {
    allBlockers.push('wallet_only_gate');
  }

  const blockersEncountered: string[] = [...new Set(allBlockers)];

  const allVisibleSignals = [
    ...new Set(observations.flatMap((o) => o.visibleSignals ?? [])),
  ];

  // ── Final page state signals ────────────────────────────────────────────
  const formAppeared =
    finalPageState.forms.some((f) => f.inputs.length > 0) ||
    observations.some((o) => (o.newInputs ?? []).length > 0);

  const enabledCtaPresent = finalPageState.buttons.some((b) => !b.disabled);

  // A run "reached the relevant surface" when:
  //   (a) the URL changed at any point during execution, OR
  //   (b) the URL was always different from the base start URL (already on surface), OR
  //   (c) the final URL contains the configured claim surface path
  //
  // Without (b) and (c), Rule 6 never fires when the verifier starts navigation
  // directly at the target path (e.g. start URL = "https://site.com/mint",
  // claimSurface = "/mint") because the URL never changes.
  const finalUrlPath = (() => {
    try { return new URL(finalPageState.url).pathname; } catch { return finalPageState.url; }
  })();
  const reachedRelevantSurface =
    routeChanged ||
    finalPageState.url !== startUrl ||
    (!!claimSurface && claimSurface !== '/' && finalUrlPath.includes(claimSurface));

  const validationHintPattern =
    /please\s+enter|required(\s+field)?|invalid\s+username|fee\s+sharing|must\s+provide|cannot\s+be\s+empty|field\s+is\s+required|this\s+field\s+is\s+required/i;
  const likelyFormValidationError = validationHintPattern.test(finalPageState.visibleText);

  return {
    siteLoaded,
    blocked,
    reachedRelevantSurface,
    finalUrl:          finalPageState.url,
    routeChanged,
    modalOpened,
    formAppeared,
    enabledCtaPresent,
    ownDomainApiCalls:  own,
    thirdPartyApiCalls: thirdParty,
    tableHeaders:       finalPageState.tableHeaders,
    chartSignals:       finalPageState.chartSignals,
    blockersEncountered,
    noopCount,
    totalSteps,
    visibleSignals:     allVisibleSignals,
    routeFallbackUsed,
    walletEvidence,
    transactionSubmitted:    txHashes.length > 0,
    // Use the LAST submitted hash — verifier.ts polls receipt for txHashes[last]
    // so both must reference the same transaction to avoid Rule 0/0a mismatches.
    transactionHash:         txHashes[txHashes.length - 1],
    transactionExplorerUrl:  txHashes[txHashes.length - 1]
      ? bscScanTxUrl(txHashes[txHashes.length - 1])
      : undefined,
    transactionReceiptStatus: txReceiptStatus,
    likelyFormValidationError,
    transactionAttempted:    txAttempted || txHashes.length > 0,
    pageJsCrash:             pageJsErrors.length > 0,
    pageJsCrashMessage:      pageJsErrors[0],
  };
}
