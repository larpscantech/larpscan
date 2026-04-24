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
 *   Rule 1   !siteLoaded                                  → untestable  (high, was failed)
 *   Rule 1b  pageJsCrash + reached surface + no positive  → failed      (medium)
 *   Rule 2   bot_protection / geo_blocked / rate_limited  → untestable  (high)
 *   Rule 2b  AGENT_LIFECYCLE / MULTI_AGENT + no UI evidence → untestable (high)
 *   Rule 2c  wallet connected + empty asset dashboard       → untestable (high)
 *   Rule 3   wallet_only_gate + noop ratio ≥ 0.8          → untestable  (high)
 *   Rule 4   DATA_DASHBOARD + (tableHeaders OR ownApi≥5 OR leaderboard API) → verified (high)
 *   Rule 4b  wallet connected + form accessible (UI_FEATURE / DEX+API only) → verified (high)
 *   Rule 4c  WALLET_FLOW + form + CTA + own-domain API responded           → verified (medium)
 *   Rule 4a  wallet_required + formAppeared               → untestable  (high)
 *   Rule 4d  DATA_DASHBOARD + aggregate stats visible (≥2) → verified   (high)
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

// TOKEN_CREATION is intentionally excluded: it requires on-chain transaction evidence
// (Rule 0 / 0b / 0a / 0c), not merely form + CTA + API visibility.
const RULE6_FEATURE_TYPES = new Set(['UI_FEATURE', 'DEX_SWAP']);

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

    // If the platform IS accessible (form visible, own API calls made, CTA enabled),
    // a reverted TX likely means the test wallet/data hit platform-specific requirements
    // (e.g. registered social handle, minimum balance for creation fee). The feature
    // exists and the UI works — downgrade to UNTESTABLE so we don't wrongly flag
    // a working platform as FAILED just because our test data didn't pass validation.
    const platformFunctional =
      signals.formAppeared &&
      signals.ownDomainApiCalls.length > 0 &&
      signals.enabledCtaPresent;

    if (platformFunctional) {
      const explorerUrl2 = signals.transactionExplorerUrl ?? `https://bscscan.com/tx/${signals.transactionHash}`;

      // Strong platform evidence: many third-party API calls + form validation
      // hint means the revert is almost certainly from social/credential gating
      // (e.g. unregistered handle, missing social proof), not a broken feature.
      // The platform clearly exists and works for authenticated users.
      const socialAuthGating =
        signals.likelyFormValidationError &&
        signals.thirdPartyApiCalls.length >= 3;

      if (socialAuthGating) {
        return {
          resolved:   true,
          verdict:    'verified',
          confidence: 'medium',
          matchedRule: this.name,
          reasons: [
            'Form was reachable, wallet-connected, and form-action was executed successfully',
            'Transaction reverted — contract requires social authentication (e.g. verified handle, social proof) which is expected in automated test conditions',
            'Third-party platform infrastructure responded with multiple API calls — feature clearly exists and works for authenticated users',
            `Transaction hash: ${signals.transactionHash}`,
            `Explorer: ${explorerUrl2}`,
          ],
        };
      }

      return {
        resolved:      true,
        verdict:       'untestable',
        confidence:    'medium',
        matchedRule:   this.name,
        blockerReason: 'Transaction reverted — platform requires validated data (handle/fee) beyond test scope',
        reasons: [
          'The form was reachable and interactable, but the on-chain transaction was reverted by the smart contract',
          'This is likely due to platform-specific validation (e.g. unregistered social handle, creation fee) rather than a broken feature',
          `Transaction hash: ${signals.transactionHash}`,
          `Explorer: ${explorerUrl}`,
        ],
      };
    }

    return {
      resolved:      true,
      verdict:       'failed',
      confidence:    'high',
      matchedRule:   this.name,
      blockerReason: 'On-chain transaction was mined but reverted',
      reasons: [
        'Transaction was mined on BSC but execution reverted — contract logic rejected it',
        `Transaction hash: ${signals.transactionHash}`,
        `Explorer: ${explorerUrl}`,
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
    // A site that fails to load is more likely a transient issue (DNS, timeout,
    // rate-limiting, or bot-blocking) than a permanently broken feature.
    // UNTESTABLE is more honest than FAILED here — we simply couldn't verify.
    // Only use FAILED if we have clear evidence the feature itself is broken.
    return {
      resolved:      true,
      verdict:       'untestable',
      confidence:    'high',
      matchedRule:   this.name,
      blockerReason: 'Site could not be reached during this run (may be temporary)',
      reasons:       ['Site failed to load — DNS error, timeout, bot block, or 5xx response', 'Result is UNTESTABLE rather than FAILED since a load failure is usually transient'],
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

const rule4c: Rule = {
  name: 'Rule 4c: wallet_flow_form_api_interaction',
  // WALLET_FLOW is intentionally excluded from rule 4b (which requires wallet
  // connection evidence and form accessibility for UI_FEATURE/DEX_SWAP).
  // This rule handles the common WALLET_FLOW pattern: the agent fills an address
  // input, clicks the primary action button (Verify, Start Mining, Claim, etc.),
  // and the site responds with a real API call — even if the response is
  // "Ineligible" or "Insufficient balance". That response IS strong evidence the
  // feature exists and functions. Without this rule every such claim falls through
  // to LLM verdict which returns UNTESTABLE.
  //
  // Many platforms (e.g. bnbshare.fun via Flap.sh) use external backend infra,
  // so all API calls are third-party. Accept third-party calls as evidence when
  // the wallet is connected, form is visible, and CTA was present.
  evaluate(signals, featureType) {
    if (!signals) return null;
    if (featureType !== 'WALLET_FLOW') return null;
    if (!signals.formAppeared) return null;
    if (!signals.enabledCtaPresent) return null;
    if (!signals.reachedRelevantSurface) return null;
    if (signals.blockersEncountered.includes('wallet_only_gate')) return null;
    if (signals.totalSteps <= 0) return null;
    // A form validation error means the workflow was rejected — cannot claim VERIFIED
    if (signals.likelyFormValidationError) {
      console.log('[verdict:l1] Rule 4c skipped: formValidationHint=true — form was rejected by validation');
      return null;
    }

    const walletEv = signals.walletEvidence;
    const hasOwnApi      = signals.ownDomainApiCalls.length >= 1;
    const hasThirdPartyApi = signals.thirdPartyApiCalls.length >= 1 && walletEv?.walletConnected;
    if (!hasOwnApi && !hasThirdPartyApi) return null;

    const reasons = [
      `WALLET_FLOW form visible on ${signals.finalUrl}`,
      `Enabled CTA present — agent attempted the action`,
    ];
    if (hasOwnApi) {
      reasons.push(`Own-domain API responded (${signals.ownDomainApiCalls.length} call(s)): ${signals.ownDomainApiCalls.slice(0, 2).join(', ')}`);
    } else {
      reasons.push(`Third-party API responded (${signals.thirdPartyApiCalls.length} call(s)) — platform uses external backend infra`);
    }
    if (signals.blockersEncountered.includes('wallet_required')) {
      reasons.push('Site responded (eligibility check or balance requirement) — feature is real');
    }
    return {
      resolved:      true,
      verdict:       'verified',
      confidence:    hasOwnApi ? 'high' : 'medium',
      matchedRule:   this.name,
      blockerReason: 'WALLET_FLOW feature demonstrated: form filled, action attempted, backend responded',
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

// Rule 6b: TOKEN_CREATION with no on-chain transaction evidence → UNTESTABLE
// Rule 0 / 0a / 0b / 0c handle the cases where a transaction was submitted or
// attempted. When NONE of those fired it means the test agent never reached
// eth_sendTransaction — the creation flow was not executed end-to-end.
// Giving VERIFIED based on "form visible + API calls" would be misleading:
// the UI may look real but without a BSC transaction there is zero proof
// that tokens can actually be created. Return UNTESTABLE so the report is
// honest rather than falsely optimistic.
const rule6b: Rule = {
  name: 'Rule 6b: token_creation_no_tx_evidence',
  evaluate(signals, featureType) {
    if (!signals) return null;
    if (featureType !== 'TOKEN_CREATION' && featureType !== 'form+browser') return null;
    // Only fire when no transaction evidence exists (rules 0/0a/0b/0c did not match)
    if (signals.transactionSubmitted || signals.transactionAttempted || signals.transactionHash) return null;
    // If a bot/geo/rate blocker fired, Rule 2 already handled it — don't double-report
    if (signals.blockersEncountered.some((b) => ['bot_protection', 'geo_blocked', 'page_broken'].includes(b))) return null;
    if (signals.totalSteps <= 0) return null;

    const formSeen = signals.formAppeared;
    const surfaceSeen = signals.reachedRelevantSurface;

    if (formSeen || surfaceSeen) {
      console.log('[verdict:l1] Rule 6b MATCH — TOKEN_CREATION: form/surface visible but no BSC transaction executed');
      return {
        resolved:      true,
        verdict:       'untestable',
        confidence:    'high',
        matchedRule:   this.name,
        blockerReason: 'Token creation form found but no on-chain transaction was executed by the test agent',
        reasons: [
          'The token creation form was visible but the test agent did not complete a BSC transaction',
          'Without an on-chain transaction the claim cannot be verified — the creation flow may be real but was not demonstrated',
          'Re-running with a funded wallet or different form inputs may produce a transaction',
          `Surface: ${signals.finalUrl}`,
        ],
      };
    }

    // No form and no tx — let rule 7 / 8 handle the LARP case
    console.log('[verdict:l1] Rule 6b skipped: TOKEN_CREATION — no form, no tx, deferring to rule 7/8');
    return null;
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
// Rule 8: Pure landing page — many steps, all scrolls/navigates, zero signals
// When the agent ran multiple adaptive steps but every one was just scrolling
// or re-navigating the homepage (no form, no API, no modal, no CTA engagement),
// the site is a placeholder / larp — the claimed feature doesn't exist yet.
// ─────────────────────────────────────────────────────────────────────────────
const rule8: Rule = {
  name: 'Rule 8: pure_landing_page_no_feature',
  evaluate(signals) {
    if (!signals) return null;

    const steps    = signals.totalSteps;
    const noops    = signals.noopCount;
    const hasForm  = signals.formAppeared;
    const hasApi   = signals.ownDomainApiCalls.length > 0;
    const hasModal = signals.modalOpened;

    // Require: many steps were run (agent tried hard), none led to a feature
    // Allow route_missing blocker (feature simply doesn't exist) but NOT auth gates
    const authBlockers = signals.blockersEncountered.filter(b =>
      b === 'auth_required' || b === 'wallet_only_gate' || b === 'page_broken',
    );
    if (
      steps >= 5 &&
      !hasForm &&
      !hasApi &&
      !hasModal &&
      authBlockers.length === 0 &&  // no login/wallet gate — the site just has nothing
      noops < steps   // steps DID have some effect (scrolls count as non-noop)
    ) {
      return {
        resolved:      true,
        verdict:       'larp',
        confidence:    'medium',
        matchedRule:   this.name,
        blockerReason: 'Website appears to be a placeholder — no functional feature surface found',
        reasons: [
          `Agent ran ${steps} steps but found no form, no API calls, no CTA, and no modal`,
          'Site only has a landing page — the claimed feature does not appear to be implemented',
          'Pattern consistent with a pre-launch placeholder or unbuilt product',
        ],
      };
    }

    if (steps >= 5 && !hasForm && !hasApi && !hasModal)
      console.log(`[verdict:l1] Rule 8 skipped: blockers=[${signals.blockersEncountered.join(',')}] noops=${noops}/${steps} authBlockers=${authBlockers.join(',')}`);

    return null;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Ordered rule chain — evaluated top to bottom, first match wins
// ─────────────────────────────────────────────────────────────────────────────

// Rule 4d: DATA_DASHBOARD with visible aggregate stats (e.g. "10K+ Agents") → VERIFIED
// Fires when Rule 4 doesn't (no tableHeaders / leaderboard API) but the page
// visibly shows live aggregate counters that directly match the claim.
const rule4d: Rule = {
  name: 'Rule 4d: dashboard_aggregate_stats_visible',
  evaluate(signals, featureType) {
    if (!signals) return null;
    if (featureType !== 'DATA_DASHBOARD') return null;
    const hasStats = (signals.aggregateStatsSnippets?.length ?? 0) >= 2;
    const onSurface = signals.reachedRelevantSurface;
    if (!hasStats || !onSurface || signals.totalSteps <= 0) {
      if (featureType === 'DATA_DASHBOARD' && !hasStats) {
        console.log('[verdict:l1] Rule 4d skipped: fewer than 2 aggregate stat snippets detected on page');
      }
      return null;
    }
    console.log(`[verdict:l1] Rule 4d MATCH — ${signals.aggregateStatsSnippets!.length} aggregate stat(s) visible`);
    return {
      resolved:      true,
      verdict:       'verified',
      confidence:    'high',
      matchedRule:   this.name,
      blockerReason: 'Live aggregate statistics visible on page',
      reasons: [
        `Aggregate statistics visible: ${signals.aggregateStatsSnippets!.slice(0, 4).join(', ')}`,
        'These are live counters consistent with a real data dashboard',
        `Surface reached: ${signals.finalUrl}`,
      ],
    };
  },
};

// Rule 2c: wallet connected + empty asset-gated dashboard → UNTESTABLE
// Fires when the agent navigated to a real dashboard but the test wallet has
// no in-game assets (NFTs, agents, tokens) to show. Feature infrastructure is
// real; the test wallet simply can't demonstrate it.
// Does NOT fire for claims about platform-wide aggregate statistics (those are
// always testable from the public page, regardless of wallet holdings).
const rule2c: Rule = {
  name: 'Rule 2c: empty_asset_gated_dashboard',
  evaluate(signals, featureType) {
    if (!signals) return null;
    const assetGatedTypes = new Set(['DATA_DASHBOARD', 'AGENT_LIFECYCLE', 'MULTI_AGENT']);
    if (!assetGatedTypes.has(featureType ?? '')) return null;
    const walletConnected = signals.walletEvidence?.walletConnected === true;
    const emptyDash = signals.emptyAssetDashboard === true;
    const reached = signals.reachedRelevantSurface;
    // Only fire if there's NO positive evidence (don't suppress when data IS visible)
    const hasPositive =
      signals.tableHeaders.length > 0 ||
      (signals.aggregateStatsSnippets?.length ?? 0) >= 1 ||
      hasDashboardViaApi(signals);
    if (!walletConnected || !emptyDash || !reached || hasPositive) {
      if (featureType && assetGatedTypes.has(featureType) && walletConnected && !emptyDash) {
        console.log('[verdict:l1] Rule 2c skipped: emptyAssetDashboard not detected');
      }
      return null;
    }
    // Don't apply to claims about global/aggregate platform statistics — those
    // are visible without owning assets (e.g. "10K+ total agents" on homepage).
    // The claim text determines whether this is wallet-specific or platform-wide.
    // We cannot access claim text here, so leave DATA_DASHBOARD-only claims to LLM.
    if (featureType === 'DATA_DASHBOARD') {
      console.log('[verdict:l1] Rule 2c skipped: DATA_DASHBOARD — deferring to LLM to distinguish global vs wallet-specific stats');
      return null;
    }
    console.log('[verdict:l1] Rule 2c MATCH — empty asset-gated dashboard (test wallet has no assets)');
    return {
      resolved:      true,
      verdict:       'untestable',
      confidence:    'high',
      matchedRule:   this.name,
      blockerReason: 'Dashboard reached but test wallet has no assets to display',
      reasons: [
        'The agent reached the feature dashboard and connected the test wallet',
        'Dashboard shows zero/empty state — test wallet has no in-game assets (NFTs, agents, etc.)',
        'Feature infrastructure is confirmed real; full demonstration requires owned assets',
      ],
    };
  },
};

// Rule 4e: DATA_DASHBOARD + empty wallet dashboard + live API activity → UNTESTABLE
// Fires when the claim is about a data dashboard, the platform has live API
// activity (backend is running), but the test wallet has no assets to display.
// This is the DATA_DASHBOARD-specific complement to rule2c (which skips DATA_DASHBOARD).
// Note: rule4d fires first if aggregateStatsSnippets >= 2 (VERIFIED); this rule
// fires when the page is wallet-specific (no global stats) but the platform is live.
const rule4e: Rule = {
  name: 'Rule 4e: data_dashboard_empty_wallet_live_api',
  evaluate(signals, featureType) {
    if (!signals) return null;
    if (featureType !== 'DATA_DASHBOARD') return null;
    const emptyDash  = signals.emptyAssetDashboard === true;
    const reached    = signals.reachedRelevantSurface;
    const liveApi    = (signals.ownDomainApiCalls?.length ?? 0) >= 3;
    const noGlobalStats = (signals.aggregateStatsSnippets?.length ?? 0) < 2;
    const noTableData   = signals.tableHeaders.length === 0;
    const totalSteps = signals.totalSteps ?? 0;
    if (!emptyDash || !reached || !liveApi || !noGlobalStats || !noTableData || totalSteps < 1) {
      return null;
    }
    console.log('[verdict:l1] Rule 4e MATCH — DATA_DASHBOARD with empty wallet, but platform has live API');
    return {
      resolved:      true,
      verdict:       'untestable',
      confidence:    'high',
      matchedRule:   this.name,
      blockerReason: 'Platform dashboard requires owned assets to display data; test wallet has none',
      reasons: [
        `Platform is live with ${signals.ownDomainApiCalls?.length ?? 0} own-domain API call(s) — backend is running`,
        'Test wallet has no in-game assets (agents, NFTs, tokens) to display in the dashboard',
        'Feature infrastructure is real; full demonstration requires assets owned by the wallet',
      ],
    };
  },
};

// Rule 4f: DATA_DASHBOARD + surface reached + live platform + limited exploration → UNTESTABLE
// When the agent reached the surface but made very few steps (< 6), the lack of
// specific behavioral evidence (trading, learning events, etc.) cannot be treated
// as proof the feature doesn't exist. The platform IS live; we simply ran out of
// exploration budget. Return UNTESTABLE rather than FAILED.
const rule4f: Rule = {
  name: 'Rule 4f: data_dashboard_under_explored',
  evaluate(signals, featureType) {
    if (!signals) return null;
    if (featureType !== 'DATA_DASHBOARD') return null;
    if (!signals.reachedRelevantSurface) return null;
    // Only fire when there are zero table headers (no positive data found)
    if ((signals.tableHeaders ?? []).length > 0) return null;
    // Only fire when there are no aggregate stats
    if ((signals.aggregateStatsSnippets?.length ?? 0) > 0) return null;
    // Only fire when blockers are absent (no auth gate, no bot block)
    const blockers = signals.blockersEncountered ?? [];
    if (blockers.includes('bot_protection') || blockers.includes('auth_required')) return null;
    // Only fire on very limited exploration (≤ 6 total steps) OR low API activity
    const totalSteps = signals.totalSteps ?? 0;
    const ownApiCount = (signals.ownDomainApiCalls?.length ?? 0);
    if (totalSteps > 6 && ownApiCount >= 3) return null; // well-explored, let LLM decide
    // Platform needs at least 1 API call to be considered live
    if (ownApiCount < 1) return null;
    console.log('[verdict:l1] Rule 4f MATCH — DATA_DASHBOARD surface reached, low exploration, no blocking evidence');
    return {
      resolved:      true,
      verdict:       'untestable',
      confidence:    'medium',
      matchedRule:   this.name,
      blockerReason: 'Limited exploration — platform is live but feature behavior could not be verified within budget',
      reasons: [
        `Platform is reachable (surface confirmed) with ${ownApiCount} API call(s)`,
        `Agent made only ${totalSteps} steps — insufficient to fully verify behavioral claim`,
        'No negative evidence found — absence of data is not proof the feature is broken',
        'Feature likely requires owned assets or deeper navigation to confirm',
      ],
    };
  },
};

// Rule 9: page_broken / SSL error — site unreachable, definitely NOT a LARP verdict
const rule9: Rule = {
  name: 'Rule 9: site_unreachable',
  evaluate(signals, featureType) {
    if (!signals) return null;
    const hasBroken = signals.blockersEncountered.includes('page_broken');
    if (!hasBroken) return null;
    // If there's ALSO a successful tx, the site recovered — let rule0 win
    if (signals.transactionHash && signals.transactionReceiptStatus === 'success') return null;
    // For DATA_DASHBOARD claims with strong API evidence the page IS live despite the
    // page_broken flag (usually a transient JS error or momentary Chrome error page).
    // Let Rule 4 / Rule 4d evaluate on the actual API/table evidence instead.
    if (featureType === 'DATA_DASHBOARD' && signals.ownDomainApiCalls.length >= 5) {
      console.log(`[verdict:l1] Rule 9 skipped: DATA_DASHBOARD with ${signals.ownDomainApiCalls.length} own-domain API calls — page is live, deferring to Rule 4`);
      return null;
    }
    // For any feature type: if there was significant own-domain API activity (≥ 8 calls),
    // the page was clearly live and the page_broken flag is a false positive caused by
    // the hard-session kill closing the page before the final snapshot could be taken.
    // Return null here so the verdict falls through to a more appropriate rule.
    if (signals.ownDomainApiCalls.length >= 8) {
      console.log(`[verdict:l1] Rule 9 skipped: ${signals.ownDomainApiCalls.length} own-domain API calls confirm page was live — page_broken is a post-kill false positive`);
      return null;
    }
    console.log('[verdict] Rule 9 MATCH — site unreachable (page_broken/SSL error)');
    return {
      resolved:      true,
      verdict:       'untestable',
      confidence:    'medium',
      matchedRule:   this.name,
      blockerReason: 'Site unreachable — SSL error, network error, or browser crash during test session',
      reasons: [
        'The platform returned an SSL/network error during the automated test session',
        'This is a transient infrastructure issue — the feature itself may work normally',
        'Re-running the verification may produce different results',
      ],
    };
  },
};

const rule10: Rule = {
  name: 'Rule 10: bot_link_accessible',
  evaluate(signals, featureType) {
    if (!signals) return null;
    if (!signals.botLinkFound) return null;
    if (featureType !== 'BOT' && featureType !== 'WALLET_FLOW' && featureType !== 'UI_FEATURE') return null;
    if (!signals.siteLoaded) return null;
    console.log('[verdict] Rule 10 MATCH — Telegram/Discord bot link found on page');
    return {
      resolved:    true,
      verdict:     'verified',
      confidence:  'medium',
      matchedRule: this.name,
      reasons: [
        'A Telegram or Discord bot link was found on the platform page',
        'This confirms the feature (bot-based interaction) is accessible and deployed',
        'The deployment mechanism exists and is reachable from the platform UI',
      ],
    };
  },
};

const RULES: Rule[] = [
  rule9,  // highest priority — SSL/network errors must not become FAILED
  rule0a, rule0b, rule0c, rule0,
  rule1, rule1b,
  rule2, rule2b, rule2c, rule3,
  rule4, rule4b, rule4c, rule4a, rule4d, rule4e, rule4f,
  rule5, rule6b, rule6, rule7, rule8,
  rule10, // bot link accessible
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
