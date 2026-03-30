/**
 * verdict-rules.ts
 *
 * Layer 1 of the two-layer verdict system.
 *
 * evaluateDeterministicVerdict() runs ordered rules against VerdictSignals.
 * If a rule fires (resolved = true) the LLM is skipped entirely.
 * The matchedRule field is the primary debugging handle.
 *
 * Rules that require signals (Rules 2–7) only execute when signals is defined.
 * When signals is undefined (non-browser strategies), only Rule 1 can fire.
 *
 * Rule order:
 *   Rule 0a  on-chain tx mined but execution reverted     → failed      (highest tx-specific)
 *   Rule 0b  tx attempted but not broadcast (e.g. insuff BNB) → verified (feature is real)
 *   Rule 0   on-chain tx succeeded (receipt status ok)    → verified    (highest)
 *   Rule 1   !siteLoaded                                  → failed      (high)
 *   Rule 1b  pageJsCrash + reached surface + no positive  → failed      (medium)
 *   Rule 2   bot_protection / geo_blocked / rate_limited  → untestable  (high)
 *   Rule 3   wallet_only_gate + noop ratio ≥ 0.8          → untestable  (high)
 *   Rule 4   DATA_DASHBOARD + tableHeaders + ownApi       → verified    (high)
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
// Feature types that Rule 6 (form + CTA + own API) applies to
// ─────────────────────────────────────────────────────────────────────────────

const RULE6_FEATURE_TYPES = new Set(['TOKEN_CREATION', 'UI_FEATURE', 'DEX_SWAP']);

// ─────────────────────────────────────────────────────────────────────────────
// evaluateDeterministicVerdict
// ─────────────────────────────────────────────────────────────────────────────

export function evaluateDeterministicVerdict(
  signals?:     VerdictSignals,
  featureType?: string,
): DeterministicVerdictResult {

  // ── Rule 0a: Tx included on-chain but execution reverted ─────────────────
  // A tx hash alone is NOT success — the dApp often shows "Transaction failed".
  if (
    signals?.transactionHash &&
    signals.transactionReceiptStatus === 'reverted'
  ) {
    const explorerUrl = signals.transactionExplorerUrl ?? `https://bscscan.com/tx/${signals.transactionHash}`;
    console.log(`[verdict] Rule 0a MATCH — tx reverted: ${signals.transactionHash}`);
    return {
      resolved:    true,
      verdict:     'failed',
      confidence:  'high',
      matchedRule: 'Rule 0a: on_chain_transaction_reverted',
      blockerReason: 'On-chain transaction was mined but reverted',
      reasons: [
        'Transaction was mined on BSC but execution reverted — contract logic rejected it (not a gas/funds issue; the node already accepted and mined the tx)',
        `Transaction hash: ${signals.transactionHash}`,
        `Explorer: ${explorerUrl}`,
        'UI "Transaction failed" is consistent with a reverted on-chain execution',
      ],
    };
  }

  // ── Rule 0b: Transaction attempted but not broadcast ─────────────────────
  // eth_sendTransaction was called (frontend built a real tx) but the RPC
  // rejected it before mining — most commonly "insufficient funds for gas".
  // The feature IS functional; the investigation wallet just doesn't have
  // enough BNB to pay for gas. Return VERIFIED so the user knows the
  // feature works and simply needs funding to complete.
  if (
    signals?.transactionAttempted &&
    !signals.transactionSubmitted &&
    signals.walletEvidence?.walletConnected &&
    signals.formAppeared &&
    signals.totalSteps > 0 &&
    !signals.likelyFormValidationError
  ) {
    console.log('[verdict] Rule 0b MATCH — tx attempted but not broadcast (insufficient funds)');
    return {
      resolved:    true,
      verdict:     'verified',
      confidence:  'medium',
      matchedRule: 'Rule 0b: transaction_attempted_insufficient_funds',
      blockerReason: 'Feature works but wallet has insufficient BNB for gas',
      reasons: [
        'eth_sendTransaction was called — the feature builds and submits real transactions',
        'Transaction was not broadcast (likely insufficient BNB for gas fees)',
        'Feature is functional; fund the investigation wallet to complete the flow',
        `Wallet: ${signals.walletEvidence?.walletAddress ?? 'investigation wallet'}`,
      ],
    };
  }

  // ── Rule 0: On-chain transaction succeeded (receipt) ─────────────────────
  // Only VERIFIED when the receipt status is success — not merely broadcast.
  if (
    signals?.transactionSubmitted &&
    signals.transactionHash &&
    signals.transactionReceiptStatus === 'success'
  ) {
    const explorerUrl = signals.transactionExplorerUrl ?? `https://bscscan.com/tx/${signals.transactionHash}`;
    console.log(`[verdict] Rule 0 MATCH — tx succeeded: ${signals.transactionHash}`);
    return {
      resolved:    true,
      verdict:     'verified',
      confidence:  'high',
      matchedRule: 'Rule 0: on_chain_transaction_succeeded',
      blockerReason: 'On-chain transaction confirmed on BSC',
      reasons: [
        `On-chain transaction succeeded on BSC mainnet (receipt status: success)`,
        `Transaction hash: ${signals.transactionHash}`,
        `Explorer: ${explorerUrl}`,
        `Wallet: ${signals.walletEvidence?.walletAddress ?? 'investigation wallet'}`,
      ],
    };
  }

  // ── Rule 1: Site did not load ─────────────────────────────────────────────
  // Safe to evaluate with or without signals — siteLoaded is always derived
  // from the Session 1 HTTP probe, independent of browser interaction.
  if (signals && !signals.siteLoaded) {
    return {
      resolved:    true,
      verdict:     'failed',
      confidence:  'high',
      matchedRule: 'Rule 1: site_not_loaded',
      blockerReason: 'Site failed to load (DNS error, timeout, or 5xx)',
      reasons:     ['Site failed to load (DNS error, timeout, or 5xx)'],
    };
  }

  // ── Rule 1b: Feature page crashed with a JS error ─────────────────────────
  // Fires when Playwright's pageerror event fired (unhandled JS exception)
  // AND there are no positive feature signals on the final page.
  //
  // This prevents the LLM from receiving an empty evidence block and concluding
  // LARP. A crashed page is NOT evidence the feature is absent — it means the
  // feature's implementation has a runtime bug. Verdict: FAILED (not LARP).
  //
  // Positive signals that suppress this rule:
  //   - Own-domain API calls (backend is live, maybe just one component crashed)
  //   - Table headers (data rendered despite the JS error)
  //   - Form appeared (some UI rendered)
  //   - Visible signals (≥3 headings/labels appeared)
  const hasPositiveSignals = signals &&
    (signals.ownDomainApiCalls.length > 0 ||
     signals.tableHeaders.length > 0 ||
     signals.formAppeared ||
     signals.visibleSignals.length >= 3);

  if (
    signals?.pageJsCrash &&
    signals.reachedRelevantSurface &&
    !hasPositiveSignals
  ) {
    const errMsg = signals.pageJsCrashMessage ?? 'JS runtime error';
    console.log(`[verdict] Rule 1b MATCH — page crashed: ${errMsg.slice(0, 80)}`);
    return {
      resolved:    true,
      verdict:     'failed',
      confidence:  'medium',
      matchedRule: 'Rule 1b: feature_page_js_crash',
      blockerReason: 'Feature page crashed with a JS runtime error',
      reasons: [
        'Feature page crashed with a JavaScript runtime error — this is a bug in the site\'s code, not evidence the feature is absent',
        `JS error: ${errMsg.slice(0, 150)}`,
        'No positive feature signals were observed (no data, no form, no own-domain API calls) — the crash prevented the feature from rendering',
        'This is FAILED (broken implementation), not LARP (feature does not exist)',
      ],
    };
  }

  // All remaining rules require signals (browser-specific evidence).
  // Non-browser strategies (BOT, CLI, API_FEATURE) return unresolved here.
  if (!signals) {
    return { resolved: false, reasons: [] };
  }

  const { blockersEncountered } = signals;

  // ── Rule 2: Explicit automation-blocking blocker detected ─────────────────
  // Only fires on typed blockers observed during live interaction.
  // Does NOT use the generic `blocked` boolean to avoid over-broadness.
  const automationBlockers: string[] = ['bot_protection', 'geo_blocked', 'rate_limited'];
  const foundAutomationBlocker = automationBlockers.find((b) => blockersEncountered.includes(b));
  if (foundAutomationBlocker) {
    return {
      resolved:    true,
      verdict:     'untestable',
      confidence:  'high',
      matchedRule: `Rule 2: automation_blocker (${foundAutomationBlocker})`,
      blockerReason: `Blocked by ${foundAutomationBlocker === 'bot_protection' ? 'CAPTCHA / bot protection' : foundAutomationBlocker === 'geo_blocked' ? 'geographic restriction' : 'rate limiting'}`,
      reasons:     [`Automation blocker detected during interaction: ${foundAutomationBlocker}`],
    };
  }

  // ── Rule 3: Wallet-only gate confirmed by executor (ratio-based) ──────────
  // Uses a ratio threshold so a single navigate step (non-noop) does not
  // prevent the rule from firing.  wallet_only_gate is only emitted by the
  // executor after replanning also fails, so this remains high-confidence.
  const noopRatio = signals.totalSteps > 0 ? signals.noopCount / signals.totalSteps : 0;
  const hasWalletOnlyGate = blockersEncountered.includes('wallet_only_gate');

  if (hasWalletOnlyGate && signals.totalSteps > 0 && noopRatio >= 0.8) {
    return {
      resolved:    true,
      verdict:     'untestable',
      confidence:  'high',
      matchedRule: 'Rule 3: wallet_only_gate_confirmed',
      blockerReason: 'Feature is entirely gated behind wallet connection',
      reasons:     [
        `Executor confirmed wallet_only_gate after replanning`,
        `Noop ratio: ${signals.noopCount}/${signals.totalSteps} (${(noopRatio * 100).toFixed(0)}%)`,
      ],
    };
  } else if (hasWalletOnlyGate) {
    console.log(
      `[verdict:l1] Rule 3 skipped: wallet_only_gate present but noop ratio ${noopRatio.toFixed(2)} < 0.8`,
    );
  } else {
    console.log('[verdict:l1] Rule 3 skipped: no wallet_only_gate blocker');
  }

  // ── Rule 4: DATA_DASHBOARD with table data and own-domain API ─────────────
  // Evaluate BEFORE wallet_required+form, so clear dashboard evidence is not
  // downgraded to untestable just because wallet connect exists on the page.
  //
  // Two paths to fire this rule:
  //   a) Classic: tableHeaders + ownDomainApiCalls (HTML <table> or detected div grid)
  //   b) API-inferred: ownDomainApiCalls includes a leaderboard/rankings/tokens endpoint
  //      AND the agent saw rich visible signals (>= 5) — covers CSS-grid dashboards
  //      where tableHeaders extraction returns empty even though data is clearly visible.
  const hasLeaderboardApi = signals.ownDomainApiCalls.some(
    (url) => /\/api\/(leaderboard|ranking|rankings|tokens|token-list|stats|scores)/i.test(url),
  );
  const hasRichVisibleData = signals.visibleSignals.length >= 5;
  const dashboardViaApi = hasLeaderboardApi && hasRichVisibleData && signals.ownDomainApiCalls.length > 0;

  if (
    featureType === 'DATA_DASHBOARD' &&
    (signals.tableHeaders.length > 0 || dashboardViaApi) &&
    signals.ownDomainApiCalls.length > 0 &&
    signals.totalSteps > 0
  ) {
    const headerDesc = signals.tableHeaders.length > 0
      ? `Table headers: ${signals.tableHeaders.slice(0, 4).join(', ')}`
      : `Leaderboard API confirmed: ${signals.ownDomainApiCalls.find((u) => /leaderboard|ranking|tokens/i.test(u)) ?? signals.ownDomainApiCalls[0]} (${signals.visibleSignals.length} visible signals)`;
    return {
      resolved:    true,
      verdict:     'verified',
      confidence:  'high',
      matchedRule: 'Rule 4: dashboard_data_confirmed',
      blockerReason: 'Dashboard data and API activity confirmed',
      reasons:     [
        headerDesc,
        `Own-domain API activity confirmed: ${signals.ownDomainApiCalls.length} call(s)`,
      ],
    };
  } else {
    if (featureType !== 'DATA_DASHBOARD') {
      console.log(`[verdict:l1] Rule 4 skipped: featureType=${featureType ?? 'UI_FEATURE'} (not DATA_DASHBOARD)`);
    } else if (signals.tableHeaders.length === 0 && !dashboardViaApi) {
      console.log(`[verdict:l1] Rule 4 skipped: no table headers and no leaderboard API match (ownApi=${signals.ownDomainApiCalls.join(',')}, signals=${signals.visibleSignals.length})`);
    } else {
      console.log('[verdict:l1] Rule 4 skipped: no own-domain API calls');
    }
  }

  // ── Rule 4b: Wallet connected + form visible → VERIFIED ─────────────────────
  // When the investigation wallet was connected AND the post-wallet page shows
  // a real form, this can prove a *generic* UI feature exists.
  //
  // NEVER use Rule 4b for TOKEN_CREATION or WALLET_FLOW: a visible /create form
  // with validation errors (e.g. "Please enter a username for fee sharing") is
  // NOT proof the claim succeeded — those need Rule 0 (on-chain success), Rule 6,
  // or LLM. DEX_SWAP only qualifies here when own-domain API activity exists.
  const walletEv = signals.walletEvidence;
  const hasAnyOwnApi = signals.ownDomainApiCalls.length > 0;
  const ft           = featureType ?? '';
  const rule4bEligible =
    !signals.likelyFormValidationError &&
    (ft === 'UI_FEATURE' || (ft === 'DEX_SWAP' && hasAnyOwnApi));

  if (!rule4bEligible && walletEv?.walletConnected && signals.formAppeared) {
    if (ft === 'TOKEN_CREATION' || ft === 'WALLET_FLOW') {
      console.log(`[verdict:l1] Rule 4b skipped: featureType=${ft} (needs on-chain or stronger evidence, not form-only)`);
    } else if (signals.likelyFormValidationError) {
      console.log('[verdict:l1] Rule 4b skipped: likelyFormValidationError on final page');
    } else if (ft === 'DEX_SWAP' && !hasAnyOwnApi) {
      console.log('[verdict:l1] Rule 4b skipped: DEX_SWAP requires own-domain API calls');
    }
  }

  if (
    walletEv?.walletConnected &&
    signals.formAppeared &&
    signals.totalSteps > 0 &&
    !walletEv.unexpectedOutflow &&
    rule4bEligible
  ) {
    const reasons = [
      `Investigation wallet connected (${walletEv.walletAddress ?? 'unknown'})`,
      `Post-wallet form is accessible on ${signals.finalUrl}`,
    ];
    if (hasAnyOwnApi) {
      reasons.push(`Own-domain API calls: ${signals.ownDomainApiCalls.length}`);
    } else {
      reasons.push(`Form-based feature — API calls on submit, not page load`);
    }
    return {
      resolved:    true,
      verdict:     'verified',
      confidence:  'high',
      matchedRule: 'Rule 4b: wallet_connected_form_accessible',
      blockerReason: 'Wallet connected and feature form is accessible',
      reasons,
    };
  }

  // ── Rule 4a: wallet_required + form visible → UNTESTABLE ─────────────────
  // The agent reached a real form/workflow but wallet gating prevents
  // completion.  This is the most common real-world case (e.g. /create page).
  const hasWalletRequired = blockersEncountered.includes('wallet_required');
  const hasStrongDashboardEvidence =
    featureType === 'DATA_DASHBOARD' &&
    (signals.tableHeaders.length > 0 || dashboardViaApi) &&
    (signals.ownDomainApiCalls.length > 0 || signals.chartSignals.length > 0);

  // If the investigation wallet was connected (even partially — e.g. Privy signed
  // the nonce), don't fire Rule 4a — let Rule 4b handle it instead.
  const walletActuallyConnected = signals.walletEvidence?.walletConnected === true;

  if (hasWalletRequired && signals.formAppeared && signals.totalSteps > 0 && !hasStrongDashboardEvidence && !walletActuallyConnected) {
    return {
      resolved:    true,
      verdict:     'untestable',
      confidence:  'high',
      matchedRule: 'Rule 4a: wallet_required_form_visible',
      blockerReason: 'Wallet connection required — feature form is visible but gated',
      reasons:     [
        'Wallet connection required to proceed',
        'Feature form/workflow is visible — feature appears real',
      ],
    };
  } else if (hasWalletRequired && hasStrongDashboardEvidence) {
    console.log('[verdict:l1] Rule 4a skipped: strong dashboard evidence present');
  } else if (hasWalletRequired && walletActuallyConnected) {
    console.log('[verdict:l1] Rule 4a skipped: investigation wallet connected — deferring to later rules / LLM');
  } else if (hasWalletRequired && !signals.formAppeared) {
    console.log('[verdict:l1] Rule 4a skipped: wallet_required present but no form appeared');
  } else {
    console.log('[verdict:l1] Rule 4a skipped: no wallet_required blocker');
  }

  // ── Rule 5: Auth wall with no accessible public UI ────────────────────────
  if (
    blockersEncountered.includes('auth_required') &&
    !signals.formAppeared &&
    !signals.enabledCtaPresent &&
    signals.totalSteps > 0
  ) {
    return {
      resolved:    true,
      verdict:     'untestable',
      confidence:  'high',
      matchedRule: 'Rule 5: auth_wall_no_public_ui',
      blockerReason: 'Login/authentication required — no public UI accessible',
      reasons:     [
        'Login wall encountered during interaction',
        'No form fields or enabled CTAs found on any visited page',
      ],
    };
  }

  // ── Rule 6: Feature form with enabled CTA and own-domain API (conservative) ─
  // Restricted to feature types where a visible, non-gated form with live
  // own-domain API activity is sufficient evidence.
  // Wallet-gated forms are explicitly excluded (already caught by Rule 4a).
  const noWalletGate =
    !blockersEncountered.includes('wallet_required') &&
    !blockersEncountered.includes('wallet_only_gate');

  if (
    signals.formAppeared &&
    signals.enabledCtaPresent &&
    signals.ownDomainApiCalls.length > 0 &&
    signals.reachedRelevantSurface &&
    noWalletGate &&
    featureType && RULE6_FEATURE_TYPES.has(featureType) &&
    signals.totalSteps > 0 &&
    !(featureType === 'TOKEN_CREATION' && signals.likelyFormValidationError)
  ) {
    return {
      resolved:    true,
      verdict:     'verified',
      confidence:  'medium',
      matchedRule: 'Rule 6: form_cta_api_on_surface',
      blockerReason: 'Feature form, CTA, and API activity confirmed on surface',
      reasons:     [
        `Feature form with enabled CTA visible on ${signals.finalUrl}`,
        `Own-domain API activity confirmed: ${signals.ownDomainApiCalls.length} call(s)`,
        `Feature type: ${featureType}`,
      ],
    };
  } else if (signals.totalSteps > 0 && featureType && RULE6_FEATURE_TYPES.has(featureType)) {
    // Log the specific condition that blocked Rule 6 for applicable feature types
    if (!signals.formAppeared)             console.log('[verdict:l1] Rule 6 skipped: no form appeared');
    else if (!signals.enabledCtaPresent)   console.log('[verdict:l1] Rule 6 skipped: no enabled CTA');
    else if (signals.ownDomainApiCalls.length === 0) console.log('[verdict:l1] Rule 6 skipped: no own-domain API calls');
    else if (!signals.reachedRelevantSurface)        console.log('[verdict:l1] Rule 6 skipped: relevant surface not reached');
    else if (!noWalletGate)                console.log('[verdict:l1] Rule 6 skipped: wallet gate present (handled by Rule 3/4a)');
    else if (featureType === 'TOKEN_CREATION' && signals.likelyFormValidationError) {
      console.log('[verdict:l1] Rule 6 skipped: TOKEN_CREATION with likely form validation error on page');
    }
  }

  // ── Rule 7: Route missing everywhere with no recovery signal ─────────────
  if (
    blockersEncountered.includes('route_missing') &&
    !signals.reachedRelevantSurface &&
    signals.noopCount === signals.totalSteps &&
    !signals.modalOpened &&
    !signals.formAppeared &&
    signals.ownDomainApiCalls.length === 0 &&
    signals.totalSteps > 0
  ) {
    return {
      resolved:    true,
      verdict:     'larp',
      confidence:  'medium',
      matchedRule: 'Rule 7: route_missing_no_recovery',
      blockerReason: 'Feature route does not exist — no page or API found',
      reasons:     [
        'Route missing blocker encountered — surface not found',
        'No relevant surface, modal, form, or API activity observed',
        `All ${signals.totalSteps} step(s) produced no effect`,
      ],
    };
  } else if (blockersEncountered.includes('route_missing')) {
    // Only log skip when route_missing was present (otherwise silent)
    if (signals.reachedRelevantSurface)    console.log('[verdict:l1] Rule 7 skipped: relevant surface was reached despite route_missing');
    else if (signals.formAppeared)         console.log('[verdict:l1] Rule 7 skipped: form appeared — possible recovery');
    else if (signals.ownDomainApiCalls.length > 0) console.log('[verdict:l1] Rule 7 skipped: own-domain API activity observed');
    else if (signals.noopCount < signals.totalSteps) console.log('[verdict:l1] Rule 7 skipped: not all steps were no-ops');
  }

  // ── Default: unresolved — pass to LLM ────────────────────────────────────
  return { resolved: false, reasons: [] };
}
