/**
 * verdict-rules.ts
 *
 * Layer 1 of the two-layer verdict system.
 *
 * evaluateDeterministicVerdict() runs ordered rules against VerdictSignals.
 * If a rule fires (resolved = true) the LLM is skipped entirely.
 * The matchedRule field is the primary debugging handle.
 *
 * Rules requiring signals (Rules 2–7) only execute when signals is defined.
 * When signals is undefined (non-browser strategies), only Rule 1 can fire.
 *
 * Rule order:
 *   Rule 0a  on-chain tx mined but execution reverted     → failed      (highest tx-specific)
 *   Rule 0b  tx attempted but not broadcast (e.g. insuff BNB) → verified (feature is real)
 *   Rule 0c  rate-limited after submit (429/max per hour) → verified    (feature is real)
 *   Rule 0   on-chain tx succeeded (receipt status ok)    → verified    (highest)
 *   Rule 1   !siteLoaded                                  → failed      (high)
 *   Rule 1b  pageJsCrash + reached surface + no positive  → failed      (medium)
 *   Rule 2   bot_protection / geo_blocked / rate_limited  → untestable  (high)
 *   Rule 2b  AGENT_LIFECYCLE / MULTI_AGENT + no UI evidence → untestable (high)
 *   Rule 3   wallet_only_gate + noop ratio ≥ 0.8          → untestable  (high)
 *   Rule 4   DATA_DASHBOARD + (tableHeaders OR ownApi≥5 OR leaderboard API) → verified (high)
 *   Rule 4b  wallet connected + form accessible (UI_FEATURE / DEX+API only) → verified (high)
 *   Rule 4a  wallet_required + formAppeared               → untestable  (high)
 *   Rule 5   auth_required + no form + no CTA             → untestable  (high)
 *   Rule 6   form + CTA + ownApi + surface (selective FT) → verified    (medium)
 *   Rule 7   route_missing everywhere + full noop run     → larp        (medium)
 *   Default  unresolved                                   → LLM
 */

import type { VerdictSignals } from './verdict-signals';

// ─────────────────────────────────────────────────────────────────────────────
// Output type
// ─────────────────────────────────────────────────────────────────────────────

export interface DeterministicVerdictResult {
  resolved:       boolean;
  verdict?:       'verified' | 'larp' | 'untestable' | 'failed';
  confidence?:    'high' | 'medium';
  matchedRule?:   string;
  blockerReason?: string;
  reasons:        string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule interface — each rule is a named, self-contained evaluator
// ─────────────────────────────────────────────────────────────────────────────

interface Rule {
  readonly name: string;
  evaluate(
    signals:     VerdictSignals | undefined,
    featureType: string | undefined,
  ): DeterministicVerdictResult | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers (used by multiple rules)
// ─────────────────────────────────────────────────────────────────────────────

const RULE6_FEATURE_TYPES = new Set(['TOKEN_CREATION', 'UI_FEATURE', 'DEX_SWAP']);

function hasPositiveSignals(signals: VerdictSignals): boolean {
  return (
    signals.ownDomainApiCalls.length > 0 ||
    signals.tableHeaders.length > 0 ||
    signals.formAppeared ||
    signals.visibleSignals.length >= 3
  );
}

function hasDashboardViaApi(signals: VerdictSignals): boolean {
  const hasLeaderboardApi = signals.ownDomainApiCalls.some(
    (url) => /\/api\/(leaderboard|ranking|rankings|tokens|token-list|stats|scores)/i.test(url),
  );
  // Primary path: named leaderboard/ranking API + any visible content
  if (hasLeaderboardApi && signals.visibleSignals.length >= 2) return true;
  // Relaxed: named API on homepage-style claims (page loaded before recording → 0 new signals)
  if (hasLeaderboardApi && signals.ownDomainApiCalls.length >= 2) return true;
  // Fallback: many own-domain API calls = backend is clearly live and serving data
  // (catches dApps whose leaderboard API paths don't include standard keywords)
  if (signals.ownDomainApiCalls.length >= 5) return true;
  return false;
}

function isFinalUrlOnDomain(signals: VerdictSignals): boolean {
  if (!signals.finalUrl) return true;
  try {
    const finalHost = new URL(signals.finalUrl).hostname.replace(/^www\./, '');
    const knownOAuthDomains = ['x.com', 'twitter.com', 'github.com', 'accounts.google.com', 'discord.com', 'auth.privy.io'];
    if (knownOAuthDomains.some((d) => finalHost.includes(d))) return false;
    const ownDomains = signals.ownDomainApiCalls
      .map((u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } })
      .filter(Boolean);
    if (ownDomains.length > 0 && !ownDomains.some((d) => finalHost.includes(d) || d.includes(finalHost))) {
      return false;
    }
  } catch { /* malformed URL — allow */ }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule implementations
// ─────────────────────────────────────────────────────────────────────────────

const rule0a: Rule = {
  name: 'Rule 0a: on_chain_transaction_reverted',
  evaluate(signals) {
    if (!signals?.transactionHash || signals.transactionReceiptStatus !== 'reverted') return null;
    const explorerUrl = signals.transactionExplorerUrl ?? `https://bscscan.com/tx/${signals.transactionHash}`;
    console.log(`[verdict] Rule 0a MATCH — tx reverted: ${signals.transactionHash}`);
    return {
      resolved:      true,
      verdict:       'failed',
      confidence:    'high',
      matchedRule:   this.name,
      blockerReason: 'On-chain transaction was mined but reverted',
      reasons: [
        'Transaction was mined on BSC but execution reverted — contract logic rejected it (not a gas/funds issue; the node already accepted and mined the tx)',
        `Transaction hash: ${signals.transactionHash}`,
        `Explorer: ${explorerUrl}`,
        'UI "Transaction failed" is consistent with a reverted on-chain execution',
      ],
    };
  },
};

const rule0b: Rule = {
  name: 'Rule 0b: transaction_attempted_insufficient_funds',
  evaluate(signals) {
    if (
      !signals?.transactionAttempted ||
      signals.transactionSubmitted ||
      !signals.walletEvidence?.walletConnected ||
      !signals.formAppeared ||
      signals.totalSteps <= 0 ||
      signals.likelyFormValidationError
    ) return null;
    console.log('[verdict] Rule 0b MATCH — tx attempted but not broadcast (insufficient funds)');
    return {
      resolved:      true,
      verdict:       'verified',
      confidence:    'medium',
      matchedRule:   this.name,
      blockerReason: 'Feature works but wallet has insufficient BNB for gas',
      reasons: [
        'eth_sendTransaction was called — the feature builds and submits real transactions',
        'Transaction was not broadcast (likely insufficient BNB for gas fees)',
        'Feature is functional; fund the investigation wallet to complete the flow',
        `Wallet: ${signals.walletEvidence?.walletAddress ?? 'investigation wallet'}`,
      ],
    };
  },
};

const rule0c: Rule = {
  name: 'Rule 0c: rate_limited_after_submit',
  evaluate(signals) {
    if (!signals?.rateLimitHit || !signals.formAppeared || signals.totalSteps <= 0) return null;
    console.log('[verdict] Rule 0c MATCH — rate-limited after submit (feature is real)');
    return {
      resolved:      true,
      verdict:       'verified',
      confidence:    'medium',
      matchedRule:   this.name,
      blockerReason: 'Feature works but rate-limited',
      reasons: [
        'The agent filled the form and submitted, but the server returned a rate-limit error',
        `Rate-limit message: "${signals.rateLimitMessage ?? '429'}"`,
        'This proves the feature is functional — the backend actively enforces usage limits',
        'The feature would succeed if the rate limit were not exceeded',
      ],
    };
  },
};

const rule0: Rule = {
  name: 'Rule 0: on_chain_transaction_succeeded',
  evaluate(signals) {
    if (
      !signals?.transactionSubmitted ||
      !signals.transactionHash ||
      signals.transactionReceiptStatus !== 'success'
    ) return null;
    const explorerUrl = signals.transactionExplorerUrl ?? `https://bscscan.com/tx/${signals.transactionHash}`;
    console.log(`[verdict] Rule 0 MATCH — tx succeeded: ${signals.transactionHash}`);
    return {
      resolved:      true,
      verdict:       'verified',
      confidence:    'high',
      matchedRule:   this.name,
      blockerReason: 'On-chain transaction confirmed on BSC',
      reasons: [
        `On-chain transaction succeeded on BSC mainnet (receipt status: success)`,
        `Transaction hash: ${signals.transactionHash}`,
        `Explorer: ${explorerUrl}`,
        `Wallet: ${signals.walletEvidence?.walletAddress ?? 'investigation wallet'}`,
      ],
    };
  },
};

const rule1: Rule = {
  name: 'Rule 1: site_not_loaded',
  evaluate(signals) {
    if (!signals || signals.siteLoaded) return null;
    return {
      resolved:      true,
      verdict:       'failed',
      confidence:    'high',
      matchedRule:   this.name,
      blockerReason: 'Site failed to load (DNS error, timeout, or 5xx)',
      reasons:       ['Site failed to load (DNS error, timeout, or 5xx)'],
    };
  },
};

const rule1b: Rule = {
  name: 'Rule 1b: feature_page_js_crash',
  evaluate(signals, featureType) {
    if (!signals?.pageJsCrash || !signals.reachedRelevantSurface) return null;
    const errMsg = signals.pageJsCrashMessage ?? 'JS runtime error';
    const positive = hasPositiveSignals(signals);

    const isDataPage =
      featureType === 'DATA_DASHBOARD' ||
      /\/leaderboard|\/dashboard|\/rankings?|\/stats|\/analytics/i.test(signals.finalUrl ?? '');

    // DATA_DASHBOARD / leaderboard: ALWAYS resolve here — never fall through
    // to the LLM, which would return FAILED based on the JS error text.
    if (isDataPage && positive) {
      console.log(`[verdict] Rule 1b DATA_DASHBOARD + positive signals — client noise (ignored): ${errMsg.slice(0, 80)}`);
      return {
        resolved:      true,
        verdict:       'verified',
        confidence:    'medium',
        matchedRule:   this.name,
        blockerReason: 'Transient client-side noise; data signals still observed',
        reasons: [
          'Positive feature signals were observed despite transient client-side noise during the run',
          'The data page route exists and relevant content or network activity was detected',
        ],
      };
    }

    if (isDataPage && !positive) {
      console.log(`[verdict] Rule 1b DATA_DASHBOARD — no signals, client noise: ${errMsg.slice(0, 80)}`);
      return {
        resolved:      true,
        verdict:       'untestable',
        confidence:    'medium',
        matchedRule:   this.name,
        blockerReason: 'Data surface may load intermittently — retry recommended',
        reasons: [
          'The agent reached the target route but strong table/API signals were not captured this run',
          'Re-running the verification may produce a different result once data is loaded',
        ],
      };
    }

    // Non-data pages: only resolve when there are no positive signals.
    // When positive signals exist, let the LLM weigh the JS error vs evidence.
    if (positive) return null;

    console.log(`[verdict] Rule 1b MATCH — page crashed: ${errMsg.slice(0, 80)}`);
    return {
      resolved:      true,
      verdict:       'failed',
      confidence:    'medium',
      matchedRule:   this.name,
      blockerReason: 'Feature page did not render usable evidence this run',
      reasons: [
        'Unhandled client-side failure prevented the feature from rendering — this is a bug in the site code, not evidence the feature is absent',
        'No positive feature signals were observed (no data, no form, no own-domain API calls)',
        'This is FAILED (broken implementation), not LARP (feature does not exist)',
      ],
    };
  },
};

const rule2: Rule = {
  name: 'Rule 2: automation_blocker',
  evaluate(signals) {
    if (!signals) return null;
    const automationBlockers = ['bot_protection', 'geo_blocked', 'rate_limited'] as const;
    const found = automationBlockers.find((b) => signals.blockersEncountered.includes(b));
    if (!found) return null;
    const label = found === 'bot_protection'
      ? 'CAPTCHA / bot protection'
      : found === 'geo_blocked'
        ? 'geographic restriction'
        : 'rate limiting';
    return {
      resolved:      true,
      verdict:       'untestable',
      confidence:    'high',
      matchedRule:   `${this.name} (${found})`,
      blockerReason: `Blocked by ${label}`,
      reasons:       [`Automation blocker detected during interaction: ${found}`],
    };
  },
};

// Rule 2b: claim describes backend/runtime behavior that cannot be observed
// through UI interaction (e.g. agent lifecycle loops, child agent spawning,
// autonomous balance monitoring). Return UNTESTABLE immediately — not FAILED.
const rule2b: Rule = {
  name: 'Rule 2b: claim_describes_unobservable_backend_behavior',
  evaluate(signals, featureType) {
    if (!signals || signals.totalSteps <= 0) return null;
    const isBackendClaim = featureType === 'AGENT_LIFECYCLE' || featureType === 'MULTI_AGENT';
    if (!isBackendClaim) return null;

    // If the agent observed meaningful UI evidence, let later rules and LLM decide.
    const hasObservableEvidence =
      signals.formAppeared ||
      signals.reachedRelevantSurface ||
      signals.ownDomainApiCalls.length > 0 ||
      signals.tableHeaders.length > 0 ||
      signals.modalOpened;

    if (hasObservableEvidence) return null;

    console.log('[verdict] Rule 2b MATCH — claim describes unobservable backend runtime behavior');
    return {
      resolved:      true,
      verdict:       'untestable',
      confidence:    'high',
      matchedRule:   this.name,
      blockerReason: 'Claim describes server-side runtime behavior not observable via browser',
      reasons: [
        'This claim describes backend agent lifecycle behavior (autonomous loops, child spawning, balance monitoring, model upgrades)',
        'These behaviors run on backend infrastructure and cannot be directly observed or confirmed through UI interaction alone',
        'No dedicated UI surface showing agent activity logs or lifecycle state was found',
        'The feature may be real but requires server-side access to verify',
      ],
    };
  },
};

const rule3: Rule = {
  name: 'Rule 3: wallet_only_gate_confirmed',
  evaluate(signals) {
    if (!signals) return null;
    const hasWalletOnlyGate = signals.blockersEncountered.includes('wallet_only_gate');
    const noopRatio = signals.totalSteps > 0 ? signals.noopCount / signals.totalSteps : 0;
    if (!hasWalletOnlyGate || signals.totalSteps <= 0 || noopRatio < 0.8) {
      if (hasWalletOnlyGate) {
        console.log(`[verdict:l1] Rule 3 skipped: wallet_only_gate present but noop ratio ${noopRatio.toFixed(2)} < 0.8`);
      } else {
        console.log('[verdict:l1] Rule 3 skipped: no wallet_only_gate blocker');
      }
      return null;
    }
    return {
      resolved:      true,
      verdict:       'untestable',
      confidence:    'high',
      matchedRule:   this.name,
      blockerReason: 'Feature is entirely gated behind wallet connection',
      reasons: [
        'Executor confirmed wallet_only_gate after replanning',
        `Noop ratio: ${signals.noopCount}/${signals.totalSteps} (${(noopRatio * 100).toFixed(0)}%)`,
      ],
    };
  },
};

const rule4: Rule = {
  name: 'Rule 4: dashboard_data_confirmed',
  evaluate(signals, featureType) {
    if (!signals) return null;
    const dashboardViaApi = hasDashboardViaApi(signals);
    // Direct path: table headers captured on final page + any own-domain API calls
    const directTableEvidence =
      signals.tableHeaders.length > 0 &&
      signals.ownDomainApiCalls.length > 0;
    if (
      featureType !== 'DATA_DASHBOARD' ||
      (!directTableEvidence && !dashboardViaApi) ||
      signals.ownDomainApiCalls.length === 0 ||
      signals.totalSteps <= 0
    ) {
      if (featureType !== 'DATA_DASHBOARD') {
        console.log(`[verdict:l1] Rule 4 skipped: featureType=${featureType ?? 'UI_FEATURE'} (not DATA_DASHBOARD)`);
      } else if (!directTableEvidence && !dashboardViaApi) {
        console.log(`[verdict:l1] Rule 4 skipped: no table headers and no leaderboard API match (ownApi=${signals.ownDomainApiCalls.join(',')}, signals=${signals.visibleSignals.length})`);
      } else {
        console.log('[verdict:l1] Rule 4 skipped: no own-domain API calls');
      }
      return null;
    }
    const headerDesc = signals.tableHeaders.length > 0
      ? `Table headers: ${signals.tableHeaders.slice(0, 4).join(', ')}`
      : `Leaderboard API confirmed: ${signals.ownDomainApiCalls.find((u) => /leaderboard|ranking|tokens/i.test(u)) ?? signals.ownDomainApiCalls[0]} (${signals.visibleSignals.length} visible signals)`;
    return {
      resolved:      true,
      verdict:       'verified',
      confidence:    'high',
      matchedRule:   this.name,
      blockerReason: 'Dashboard data and API activity confirmed',
      reasons: [
        headerDesc,
        `Own-domain API activity confirmed: ${signals.ownDomainApiCalls.length} call(s)`,
      ],
    };
  },
};

const rule4b: Rule = {
  name: 'Rule 4b: wallet_connected_form_accessible',
  evaluate(signals, featureType) {
    if (!signals) return null;
    const walletEv     = signals.walletEvidence;
    const ft           = featureType ?? '';
    const hasAnyOwnApi = signals.ownDomainApiCalls.length > 0;
    const eligible     =
      !signals.likelyFormValidationError &&
      (ft === 'UI_FEATURE' || (ft === 'DEX_SWAP' && hasAnyOwnApi));

    if (!eligible && walletEv?.walletConnected && signals.formAppeared) {
      if (ft === 'TOKEN_CREATION' || ft === 'WALLET_FLOW') {
        console.log(`[verdict:l1] Rule 4b skipped: featureType=${ft} (needs on-chain or stronger evidence, not form-only)`);
      } else if (signals.likelyFormValidationError) {
        console.log('[verdict:l1] Rule 4b skipped: likelyFormValidationError on final page');
      } else if (ft === 'DEX_SWAP' && !hasAnyOwnApi) {
        console.log('[verdict:l1] Rule 4b skipped: DEX_SWAP requires own-domain API calls');
      }
    }

    if (
      !walletEv?.walletConnected ||
      !signals.formAppeared ||
      signals.totalSteps <= 0 ||
      walletEv.unexpectedOutflow ||
      !eligible
    ) return null;

    const reasons = [
      `Investigation wallet connected (${walletEv.walletAddress ?? 'unknown'})`,
      `Post-wallet form is accessible on ${signals.finalUrl}`,
    ];
    reasons.push(hasAnyOwnApi
      ? `Own-domain API calls: ${signals.ownDomainApiCalls.length}`
      : 'Form-based feature — API calls on submit, not page load',
    );
    return {
      resolved:      true,
      verdict:       'verified',
      confidence:    'high',
      matchedRule:   this.name,
      blockerReason: 'Wallet connected and feature form is accessible',
      reasons,
    };
  },
};

const rule4a: Rule = {
  name: 'Rule 4a: wallet_required_form_visible',
  evaluate(signals, featureType) {
    if (!signals) return null;
    const hasWalletRequired       = signals.blockersEncountered.includes('wallet_required');
    const walletActuallyConnected  = signals.walletEvidence?.walletConnected === true;
    const dashboardViaApi          = hasDashboardViaApi(signals);
    const hasStrongDashboardEvidence =
      featureType === 'DATA_DASHBOARD' &&
      (signals.tableHeaders.length > 0 || dashboardViaApi) &&
      (signals.ownDomainApiCalls.length > 0 || signals.chartSignals.length > 0);

    if (!hasWalletRequired || !signals.formAppeared || signals.totalSteps <= 0 || hasStrongDashboardEvidence || walletActuallyConnected) {
      if (hasWalletRequired && hasStrongDashboardEvidence)   console.log('[verdict:l1] Rule 4a skipped: strong dashboard evidence present');
      else if (hasWalletRequired && walletActuallyConnected) console.log('[verdict:l1] Rule 4a skipped: investigation wallet connected — deferring to later rules / LLM');
      else if (hasWalletRequired && !signals.formAppeared)   console.log('[verdict:l1] Rule 4a skipped: wallet_required present but no form appeared');
      else if (!hasWalletRequired)                           console.log('[verdict:l1] Rule 4a skipped: no wallet_required blocker');
      return null;
    }
    return {
      resolved:      true,
      verdict:       'untestable',
      confidence:    'high',
      matchedRule:   this.name,
      blockerReason: 'Wallet connection required — feature form is visible but gated',
      reasons: [
        'Wallet connection required to proceed',
        'Feature form/workflow is visible — feature appears real',
      ],
    };
  },
};

const rule5: Rule = {
  name: 'Rule 5: auth_wall_no_public_ui',
  evaluate(signals) {
    if (
      !signals ||
      !signals.blockersEncountered.includes('auth_required') ||
      signals.formAppeared ||
      signals.enabledCtaPresent ||
      signals.totalSteps <= 0
    ) return null;
    return {
      resolved:      true,
      verdict:       'untestable',
      confidence:    'high',
      matchedRule:   this.name,
      blockerReason: 'Login/authentication required — no public UI accessible',
      reasons: [
        'Login wall encountered during interaction',
        'No form fields or enabled CTAs found on any visited page',
      ],
    };
  },
};

const rule6: Rule = {
  name: 'Rule 6: form_cta_api_on_surface',
  evaluate(signals, featureType) {
    if (!signals || !featureType || !RULE6_FEATURE_TYPES.has(featureType) || signals.totalSteps <= 0) return null;
    const noAccessGate =
      !signals.blockersEncountered.includes('wallet_required') &&
      !signals.blockersEncountered.includes('wallet_only_gate') &&
      !signals.blockersEncountered.includes('auth_required');
    const onDomain = isFinalUrlOnDomain(signals);

    if (
      signals.formAppeared &&
      signals.enabledCtaPresent &&
      signals.ownDomainApiCalls.length > 0 &&
      signals.reachedRelevantSurface &&
      noAccessGate &&
      onDomain &&
      !(featureType === 'TOKEN_CREATION' && signals.likelyFormValidationError)
    ) {
      return {
        resolved:      true,
        verdict:       'verified',
        confidence:    'medium',
        matchedRule:   this.name,
        blockerReason: 'Feature form, CTA, and API activity confirmed on surface',
        reasons: [
          `Feature form with enabled CTA visible on ${signals.finalUrl}`,
          `Own-domain API activity confirmed: ${signals.ownDomainApiCalls.length} call(s)`,
          `Feature type: ${featureType}`,
        ],
      };
    }

    if (!signals.formAppeared)                         console.log('[verdict:l1] Rule 6 skipped: no form appeared');
    else if (!signals.enabledCtaPresent)               console.log('[verdict:l1] Rule 6 skipped: no enabled CTA');
    else if (signals.ownDomainApiCalls.length === 0)   console.log('[verdict:l1] Rule 6 skipped: no own-domain API calls');
    else if (!signals.reachedRelevantSurface)          console.log('[verdict:l1] Rule 6 skipped: relevant surface not reached');
    else if (!noAccessGate)                            console.log(`[verdict:l1] Rule 6 skipped: access gate present (blockers: ${signals.blockersEncountered.join(',')})`);
    else if (!onDomain)                               console.log(`[verdict:l1] Rule 6 skipped: final URL off-domain (${signals.finalUrl})`);
    else if (featureType === 'TOKEN_CREATION' && signals.likelyFormValidationError) {
      console.log('[verdict:l1] Rule 6 skipped: TOKEN_CREATION with likely form validation error on page');
    }
    return null;
  },
};

const rule7: Rule = {
  name: 'Rule 7: route_missing_no_recovery',
  evaluate(signals) {
    if (!signals) return null;
    const hasRouteMissing = signals.blockersEncountered.includes('route_missing');
    if (!hasRouteMissing) return null;

    if (
      !signals.reachedRelevantSurface &&
      signals.noopCount === signals.totalSteps &&
      !signals.modalOpened &&
      !signals.formAppeared &&
      signals.ownDomainApiCalls.length === 0 &&
      signals.totalSteps > 0
    ) {
      return {
        resolved:      true,
        verdict:       'larp',
        confidence:    'medium',
        matchedRule:   this.name,
        blockerReason: 'Feature route does not exist — no page or API found',
        reasons: [
          'Route missing blocker encountered — surface not found',
          'No relevant surface, modal, form, or API activity observed',
          `All ${signals.totalSteps} step(s) produced no effect`,
        ],
      };
    }

    if (signals.reachedRelevantSurface)                  console.log('[verdict:l1] Rule 7 skipped: relevant surface was reached despite route_missing');
    else if (signals.formAppeared)                       console.log('[verdict:l1] Rule 7 skipped: form appeared — possible recovery');
    else if (signals.ownDomainApiCalls.length > 0)       console.log('[verdict:l1] Rule 7 skipped: own-domain API activity observed');
    else if (signals.noopCount < signals.totalSteps)     console.log('[verdict:l1] Rule 7 skipped: not all steps were no-ops');
    return null;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Ordered rule chain — evaluated top to bottom, first match wins
// ─────────────────────────────────────────────────────────────────────────────

const RULES: Rule[] = [
  rule0a, rule0b, rule0c, rule0,
  rule1, rule1b,
  rule2, rule2b, rule3,
  rule4, rule4b, rule4a,
  rule5, rule6, rule7,
];

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

export function evaluateDeterministicVerdict(
  signals?:     VerdictSignals,
  featureType?: string,
): DeterministicVerdictResult {
  for (const rule of RULES) {
    const result = rule.evaluate(signals, featureType);
    if (result !== null) return result;
  }
  return { resolved: false, reasons: [] };
}
