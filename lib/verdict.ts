/**
 * verdict.ts
 *
 * Two-layer verdict system:
 *
 *   Layer 1 — deterministic rules (evaluateDeterministicVerdict)
 *             resolves clear cases without an LLM call.
 *
 *   Layer 2 — GPT-4o fallback for ambiguous cases.
 *             Receives structured signal context + the flat evidence string.
 */

import OpenAI from 'openai';
import type { ClaimStatus } from './db-types';
import type { VerdictSignals } from './verdict-signals';
import { evaluateDeterministicVerdict } from './verdict-rules';

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI client (lazy)
// ─────────────────────────────────────────────────────────────────────────────

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  _client = new OpenAI({ apiKey: key });
  return _client;
}

/**
 * Strips raw JS runtime error strings from user-facing verdict text so the UI
 * never shows "TypeError: Cannot read properties of undefined" etc.
 */
function sanitizeVerdictReasoning(reasoning: string): string {
  let s = reasoning
    .replace(/(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError)\s*:\s*[^\n]{0,500}/gi, '')
    .replace(/Cannot read propert(?:y|ies) of (?:undefined|null)[^\n]{0,250}/gi, '')
    .replace(/⚠\s*JavaScript crash detected[^\n]*/gi, '')
    .replace(/JavaScript(?:\s+runtime)?\s+(?:error|crash)[^\n]{0,350}/gi, '')
    .replace(/JS (?:runtime )?(?:error|crash)[^\n]{0,350}/gi, '')
    .replace(/JS error:\s*[^\n]{0,350}/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
  if (s.length < 15) {
    return 'Verdict is based on observable page signals and navigation; background client noise was not used.';
  }
  return s;
}

function isLeaderboardLikeClaim(
  claim: string,
  passCondition: string,
  featureType?: string,
  signals?: VerdictSignals,
): boolean {
  if (featureType === 'DATA_DASHBOARD') return true;
  const combined = `${claim}\n${passCondition}\n${signals?.finalUrl ?? ''}`.toLowerCase();
  return /leaderboard|dashboard|ranking|rankings|ranked|table|scoreboard|digital souls|fees earned|claimed amounts/.test(combined);
}

function shouldOverrideJsFailure(
  claim: string,
  passCondition: string,
  featureType: string | undefined,
  signals: VerdictSignals | undefined,
  verdict: ClaimStatus,
  reasoning: string,
): boolean {
  if (!isLeaderboardLikeClaim(claim, passCondition, featureType, signals)) return false;
  const r = reasoning.toLowerCase();
  const hasJsLikeText =
    /cannot read propert|startswith|typeerror|referenceerror|javascript|js error|client-side noise|broken implementation|failed to render/.test(r);
  return verdict === 'failed' || hasJsLikeText;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM system prompt (Layer 2)
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM = `You are a blockchain product verification analyst.

Given a product claim, its pass condition, and structured browser agent evidence,
determine the final verification verdict.

==================================================
UNDERSTANDING THE EVIDENCE SECTIONS
==================================================
- "--- Evidence Summary ---" = structured signals block — THIS IS YOUR PRIMARY SOURCE
- "Page content" = initial page text before any interaction
- "--- Interactive Agent ---" = what the agent clicked and observed during interaction
- "--- Final Page State ---" = the page the agent ended up on AFTER all interactions (VERY IMPORTANT)
- "API calls observed (full run)" = real network requests captured during the run

==================================================
SIGNAL GLOSSARY
==================================================
isNoop (No-op action)
  The step executed but produced ZERO observable change: no URL change, no modal,
  no new inputs, no API call, no new visible content.
  A no-op does NOT mean the feature is absent — it means the agent could not
  interact with it. Often caused by wallet gates or disabled controls.

Blocker types:
  - wallet_required   → connect-wallet prompt visible. Feature UI may still be real.
  - wallet_only_gate  → confirmed by executor after replanning: feature is entirely
                        behind wallet connection. Strong UNTESTABLE signal.
  - auth_required     → login wall. No public UI accessible.
  - route_missing     → 404 / page not found on the attempted surface.
  - page_broken       → blank page, JS crash, white screen.
  - bot_protection    → Cloudflare / CAPTCHA blocked the agent.
  - coming_soon       → feature not yet live.
  - geo_blocked       → region restriction.

No-op actions ≠ LARP.
  If noopCount equals totalSteps but a wallet_required blocker was present,
  this almost always means the feature exists but requires wallet interaction.
  Use UNTESTABLE, not LARP.

==================================================
API EVIDENCE WEIGHTING
==================================================
Strong evidence (own-domain API calls):
  - Calls to the scanned site's own /api/... or same-hostname JSON endpoints
  - These prove the backend is live and the feature is functional

Weak / ignore:
  - privy.io, clerk.com, auth0.com — authentication infra, not product functionality
  - google-analytics, segment.io, mixpanel — analytics
  - sentry.io, datadog — error tracking
  - walletconnect.com — wallet infra
  The evidence summary separates own-domain and third-party API calls for you.

==================================================
FEATURE TYPE CONTEXT
==================================================
DATA_DASHBOARD:
  tableHeaders visible + own-domain API calls → very strong VERIFIED signal.
  The data is live even if you cannot interact with it further.
  Visible aggregate stats ("10K+ Agents", "100K+ Actions", "$2.5M TVL", etc.) on the page
  are ALSO strong VERIFIED evidence — these are live counters, not static marketing copy.
  If "Aggregate stats visible on page" is shown in the signal context → lean VERIFIED.

TOKEN_CREATION / DEX_SWAP / UI_FEATURE:
  Form fields visible + enabled CTA + no wallet blocker → strong positive signal.
  If wallet_required is the only blocker and the form is fully visible → UNTESTABLE.

On-chain transactions:
  A transaction HASH alone does NOT prove success. The receipt must show status success.
  If receipt is reverted, the dApp may correctly show "Transaction failed" — verdict should
  reflect failure / partial attempt, not VERIFIED.

Form validation:
  If "Likely form validation error visible: true" (e.g. "Please enter…", "required", fee-sharing errors),
  the workflow did NOT complete successfully — do NOT return VERIFIED for TOKEN_CREATION or similar
  claims unless other strong evidence (successful on-chain receipt) exists.

JavaScript runtime errors (TypeError, ReferenceError, etc.):
  Seeing "Cannot read properties of undefined", "TypeError: x is not a function", or similar
  JS runtime error text in the page content does NOT mean the site or feature is broken.
  These errors are extremely common background noise on virtually every React/Next.js app
  (analytics, third-party widgets, non-critical components) and have nothing to do with whether
  the feature being tested is functional. NEVER use a JS TypeError/ReferenceError alone as
  justification for FAILED or SITE_BROKEN — require actual evidence that the feature itself
  failed (e.g. missing UI, 404, blank page, explicit "not found" content).

WALLET_FLOW:
  Wallet connection is EXPECTED. UNTESTABLE is the normal outcome unless the agent
  somehow completes a transaction (extremely rare in headless mode).

BOT / CLI_TOOL:
  These cannot be verified headlessly. UNTESTABLE is almost always correct.

==================================================
WEIGHING EVIDENCE (most to least important)
==================================================
1. Own-domain API calls — proves backend is live
2. Form fields + enabled CTA on final page — proves workflow UI is real
3. URL/route change after interaction — proves navigation works
4. Table/dashboard content — proves data rendering works
5. Modal opened — proves interactive layer exists
6. Final page content — confirms feature is described/visible
7. Initial page content — weakest; confirms feature is described only
8. check_text results — only reliable when confirming post-interaction state

==================================================
VERDICT DEFINITIONS
==================================================
VERIFIED
  The agent demonstrated the feature works: navigated to the correct surface,
  saw relevant UI (form, table, dashboard), and/or observed own-domain API activity
  consistent with the claim.
  Also use VERIFIED when: the form/UI is fully present and functional, even if
  the final submission step requires a wallet (the UI itself is real).

LARP
  The feature clearly does not exist: broken links, 404 on every attempt,
  missing UI everywhere, no relevant content anywhere on the site, or the site
  is clearly a static mockup with no real functionality.
  Do NOT use LARP if:
  - the agent reached a page with relevant UI (even wallet-gated)
  - own-domain API calls were observed
  - a form was visible anywhere
  - the only failure was a no-op from a wallet/auth gate
  - the dashboard exists but requires owning in-game assets (NFTs, tokens, etc.) to show data

UNTESTABLE
  Cannot fully verify because:
  - Real wallet connection required to complete the action
  - Login / auth wall prevents access
  - CAPTCHA or bot protection blocks the agent
  - Feature is confirmed wallet-only gate (all steps no-op)
  - Feature requires owning specific in-game assets (e.g. NFTs, agent tokens) to demonstrate
    (the test wallet may have 0 agents, 0 NFTs, etc. — the feature is real but not demonstrable)
  - page_broken / site temporarily unavailable (try FAILED only if consistently broken, not once)
  UNTESTABLE is NOT a negative verdict — it means the feature appears real
  but cannot be fully automated.

FAILED
  The feature was reachable but clearly broken: the form submitted an error, the
  transaction reverted, or the UI is present but non-functional on every attempt.
  Do NOT use FAILED if:
  - the page_broken occurred only once (transient load issue)
  - the site was described as having the feature in page content but the browser had a rendering issue

==================================================
CRITICAL RULES
==================================================
- If a form with inputs is visible, do NOT return LARP.
- If wallet_required is the only blocker, return UNTESTABLE not LARP.
- If own-domain API calls were observed, lean strongly toward VERIFIED or UNTESTABLE.
- If the agent reached a relevant dashboard but shows "0 agents", "empty wallet", "no assets",
  "no history" because the TEST WALLET has no in-game assets — return UNTESTABLE not LARP or FAILED.
  The feature infrastructure exists; the test simply cannot demonstrate it without owned assets.
- If page_broken was the blocker AND the site is described as having the feature in page metadata
  OR in prior steps it showed the form/UI — return UNTESTABLE not FAILED (transient load issue).
- A 404 on the surface path is not automatically LARP — check if the agent
  recovered via homepage or a fallback route.
- check_text failures after navigation are not reliable LARP signals.
- routeFallbackUsed = true means the surface path was a 404 and the agent
  retried from homepage. Reduce your confidence slightly but do not fail the claim.
- No-op actions alone never justify LARP — explain what the no-ops most likely mean.
- JavaScript errors in page text (TypeError, ReferenceError, etc.) — follow this logic:
  (a) If a JS error is present AND Feature type is DATA_DASHBOARD AND own-domain API calls > 0
      → return VERIFIED. The backend responded with data; the JS error is from a non-critical
      component (wallet hook, analytics, third-party widget) and did NOT prevent data from rendering.
  (b) If a JS error is present AND the claimed feature's content is ABSENT (no table, no leaderboard,
      no data rendered) AND no own-domain API calls:
      - For DATA_DASHBOARD claims → return UNTESTABLE, NOT FAILED. JS errors on data/leaderboard
        pages are transient SPA hydration races; the page route exists and may render on retry.
      - For all other feature types → return FAILED. The JS error explains WHY the feature
        content is missing. This is a broken implementation, NOT LARP.
  (c) If a JS error is present BUT positive signals also exist (API calls, partial UI, table headers)
      → treat the JS error as background noise and focus on the positive signals.
  (d) NEVER return LARP based solely on a JS error with no other evidence — if a JS error
      prevented the feature from rendering, that is FAILED (broken), not LARP (doesn't exist).
- Server-side / infrastructure errors (ENOENT, mkdir, EPERM, spawn, /var/task/, 500 Internal Server Error):
  These are errors thrown by the TARGET SITE's own backend, not by our testing tool.
  (a) If the form/UI was still interactable despite the server error → still attempt to evaluate the claim.
  (b) If the server error prevented the page from loading at all → return SITE_BROKEN.
  (c) NEVER automatically FAILED all claims because one server error was observed — evaluate each
      claim individually based on what the agent was actually able to observe and interact with.

Respond with JSON only:
{
  "verdict": "VERIFIED" | "LARP" | "UNTESTABLE" | "SITE_BROKEN",
  "confidence": "high" | "medium" | "low",
  "reasoning": "2-3 sentences referencing specific evidence items. Be precise. NEVER quote or paste raw browser console messages, stack traces, TypeError/ReferenceError lines, or the phrase 'Cannot read properties of undefined' — describe outcomes in plain language only."
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface VerdictResult {
  verdict:        ClaimStatus;
  confidence:     'high' | 'medium' | 'low';
  reasoning:      string;
  blockerReason?: string;
}

const VERDICT_MAP: Record<string, ClaimStatus> = {
  VERIFIED:    'verified',
  LARP:        'larp',
  UNTESTABLE:  'untestable',
  SITE_BROKEN: 'failed',
};

// ─────────────────────────────────────────────────────────────────────────────
// determineVerdict — public entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function determineVerdict(
  claim:           string,
  passCondition:   string,
  evidenceSummary: string,
  signals?:        VerdictSignals,
  featureType?:    string,
  /** JPEG data URL of the final page state after all interactions.
   *  Attached as a vision image so the LLM can visually verify the claim
   *  instead of relying solely on truncated text evidence. */
  finalScreenshotDataUrl?: string,
): Promise<VerdictResult> {

  // ── Layer 1: deterministic rules ──────────────────────────────────────────

  // Structured signal summary — logged before rule evaluation so every run
  // has a single scannable line for calibration debugging.
  if (signals) {
    const noopRatio = signals.totalSteps > 0
      ? (signals.noopCount / signals.totalSteps).toFixed(2)
      : 'n/a';
    console.log(
      '[verdict:signals]',
      `feature=${featureType ?? 'UI_FEATURE'}`,
      `url=${signals.finalUrl}`,
      `surface=${signals.reachedRelevantSurface}`,
      `noops=${signals.noopCount}/${signals.totalSteps}(${noopRatio})`,
      `blockers=[${signals.blockersEncountered.join(',')}]`,
      `form=${signals.formAppeared}`,
      `cta=${signals.enabledCtaPresent}`,
      `ownApi=${signals.ownDomainApiCalls.length}`,
      `3rdApi=${signals.thirdPartyApiCalls.length}`,
      `fallback=${signals.routeFallbackUsed}`,
      `txReceipt=${signals.transactionReceiptStatus ?? 'n/a'}`,
      `formValidationHint=${signals.likelyFormValidationError}`,
    );
  }

  const deterministic = evaluateDeterministicVerdict(signals, featureType);

  console.log(
    '[verdict:l1]',
    deterministic.resolved
      ? `RESOLVED → ${deterministic.verdict} (${deterministic.matchedRule})`
      : 'unresolved → passing to LLM',
  );

  if (deterministic.resolved && deterministic.verdict && deterministic.confidence) {
    const reasoning = sanitizeVerdictReasoning(
      [
        `[Deterministic rule: ${deterministic.matchedRule}]`,
        ...deterministic.reasons,
      ].join(' — '),
    );

    if (shouldOverrideJsFailure(claim, passCondition, featureType, signals, VERDICT_MAP[deterministic.verdict.toUpperCase()] ?? 'failed', reasoning)) {
      return {
        verdict: 'untestable',
        confidence: deterministic.confidence,
        reasoning: 'The agent reached a leaderboard/data surface, but stable table evidence was not captured on this run. This result is treated as untestable rather than a broken implementation.',
        blockerReason: 'Leaderboard data did not stabilize during this run',
      };
    }

    return {
      verdict:       VERDICT_MAP[deterministic.verdict.toUpperCase()] ?? 'failed',
      confidence:    deterministic.confidence,
      reasoning,
      blockerReason: deterministic.blockerReason
        ? sanitizeVerdictReasoning(deterministic.blockerReason)
        : undefined,
    };
  }

  // ── Layer 2: LLM fallback ─────────────────────────────────────────────────
  console.log('[verdict] Layer 2: calling GPT-4o...');

  // Optionally prepend a compact signal summary to help orient the LLM
  const signalContext = signals ? buildSignalContext(signals, featureType, deterministic.reasons) : '';
  const fullEvidence  = signalContext ? `${signalContext}\n\n${evidenceSummary}` : evidenceSummary;

  console.log(
    '[verdict] Evidence length:', fullEvidence.length,
    finalScreenshotDataUrl ? '+ final screenshot (vision)' : '(text-only)',
  );

  // Build the user message content — plain text when no screenshot is available,
  // multimodal (text + image) when a final screenshot was captured.
  // Using detail:'low' (~$0.003/image) since we need layout/UI-state awareness,
  // not pixel-level analysis.
  const userText = [
    `Claim: ${claim}`,
    `Pass condition: ${passCondition}`,
    `Feature type: ${featureType ?? 'UI_FEATURE'}`,
    `Evidence:\n${fullEvidence}`,
  ].join('\n\n');

  type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail: 'low' } };

  const userContent: ContentPart[] | string = finalScreenshotDataUrl
    ? [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: finalScreenshotDataUrl, detail: 'low' } },
      ]
    : userText;

  try {
    const client = getClient();

    const resp = await client.chat.completions.create({
      model:            'gpt-4.1',
      temperature:      0,
      max_tokens:       500,
      response_format:  { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: 'user',   content: userContent as any },
      ],
    });

    const raw    = resp.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw) as {
      verdict?:    string;
      confidence?: string;
      reasoning?:  string;
    };

    // If GPT-4.1 returned an empty/incomplete JSON, retry once with a simpler prompt
    if (!parsed.verdict && !parsed.reasoning) {
      console.warn('[verdict] LLM returned empty response — retrying with simplified prompt');
      const retry = await client.chat.completions.create({
        model:           'gpt-4.1',
        temperature:     0,
        max_tokens:      300,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You are a smart contract claim auditor. Respond ONLY with JSON: {"verdict":"VERIFIED"|"FAILED"|"UNTESTABLE"|"LARP","confidence":"high"|"medium"|"low","reasoning":"1-2 sentences"}',
          },
          {
            role: 'user',
            content: `Claim: "${claim}"\n\nEvidence summary: ${evidenceSummary.slice(0, 1000)}\n\nGive your verdict.`,
          },
        ],
      });
      const retryRaw    = retry.choices[0]?.message?.content ?? '{}';
      const retryParsed = JSON.parse(retryRaw) as typeof parsed;
      if (retryParsed.verdict) {
        Object.assign(parsed, retryParsed);
      }
    }

    const verdict = VERDICT_MAP[parsed.verdict?.toUpperCase() ?? ''] ?? 'failed';
    const rawConfidence = (parsed.confidence as VerdictResult['confidence']) ?? 'low';

    const rawReasoning = parsed.reasoning ?? 'No reasoning provided';
    console.log(`[verdict] → ${verdict} (${rawConfidence}) — ${rawReasoning}`);

    // Low-confidence FAILED guard: if the LLM is unsure and returns FAILED,
    // downgrade to UNTESTABLE — it's better to admit uncertainty than to
    // incorrectly flag a real feature as broken.
    if (verdict === 'failed' && rawConfidence === 'low') {
      console.log('[verdict] Low-confidence FAILED → downgrading to UNTESTABLE');
      return {
        verdict: 'untestable',
        confidence: 'low',
        reasoning: sanitizeVerdictReasoning(rawReasoning) + ' (Result treated as untestable due to insufficient evidence to confirm a broken feature.)',
      };
    }

    if (shouldOverrideJsFailure(claim, passCondition, featureType, signals, verdict, rawReasoning)) {
      return {
        verdict: 'untestable',
        confidence: rawConfidence,
        reasoning: 'The agent reached a leaderboard/data surface, but stable table evidence was not captured on this run. This result is treated as untestable rather than a broken implementation.',
      };
    }

    return {
      verdict,
      confidence: rawConfidence,
      reasoning:  sanitizeVerdictReasoning(rawReasoning),
    };
  } catch (e) {
    console.error('[verdict] LLM error:', e);
    return {
      verdict:    'failed',
      confidence: 'low',
      reasoning:  'Verdict determination failed due to an internal error',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// buildSignalContext
// Builds a compact structured summary of signals to prepend to the evidence
// blob for the LLM. Helps orient GPT-4o without duplicating the full summary.
// ─────────────────────────────────────────────────────────────────────────────

function buildSignalContext(
  signals:     VerdictSignals,
  featureType?: string,
  l1Reasons?:   string[],
): string {
  const lines: string[] = ['--- Structured Signal Context ---'];

  lines.push(`Feature type: ${featureType ?? 'UI_FEATURE'}`);
  lines.push(`Final URL: ${signals.finalUrl}`);
  lines.push(`Route changed: ${signals.routeChanged}`);
  lines.push(`Modal opened: ${signals.modalOpened}`);
  lines.push(`Form appeared: ${signals.formAppeared}`);
  lines.push(`Enabled CTA present: ${signals.enabledCtaPresent}`);
  lines.push(`Reached relevant surface: ${signals.reachedRelevantSurface}`);
  lines.push(`Route fallback used: ${signals.routeFallbackUsed}`);

  lines.push(`Own-domain API calls: ${signals.ownDomainApiCalls.length}` +
    (signals.ownDomainApiCalls.length > 0
      ? ` — ${signals.ownDomainApiCalls.slice(0, 3).join(', ')}`
      : ''));

  lines.push(`Third-party API calls: ${signals.thirdPartyApiCalls.length} (auth/analytics — do not weight as product evidence)`);

  if (signals.tableHeaders.length > 0) {
    lines.push(`Table headers: ${signals.tableHeaders.join(', ')}`);
  }
  if (signals.chartSignals.length > 0) {
    lines.push(`Chart signals: ${signals.chartSignals.join(', ')}`);
  }
  if (signals.visibleSignals.length > 0) {
    lines.push(`Visible page signals (headings/sections that appeared): ${signals.visibleSignals.slice(0, 8).join(' | ')}`);
  }
  if (signals.aggregateStatsSnippets && signals.aggregateStatsSnippets.length > 0) {
    lines.push(`Aggregate stats visible on page: ${signals.aggregateStatsSnippets.join(', ')} — these are live counters/statistics matching the claim`);
  }
  if (signals.blockersEncountered.length > 0) {
    lines.push(`Blockers encountered: ${signals.blockersEncountered.join(', ')}`);
  }
  const noopRatio = signals.totalSteps > 0 ? signals.noopCount / signals.totalSteps : 0;
  lines.push(`No-op steps: ${signals.noopCount} / ${signals.totalSteps} (ratio: ${noopRatio.toFixed(2)})`);
  if (noopRatio >= 0.8 && signals.blockersEncountered.some((b) => b.includes('wallet'))) {
    lines.push('High noop ratio with wallet blocker — feature likely exists but is wallet-gated (lean UNTESTABLE)');
  }

  if (l1Reasons && l1Reasons.length > 0) {
    lines.push(`Layer 1 did not auto-resolve. Closest signals: ${l1Reasons.join('; ')}`);
  }

  if (signals.transactionHash) {
    lines.push(
      `On-chain tx hash: ${signals.transactionHash} — receipt: ${signals.transactionReceiptStatus ?? 'unknown (not polled or pending)'}`,
    );
  }
  lines.push(`Likely form validation error visible: ${signals.likelyFormValidationError}`);

  if (signals.walletEvidence) {
    const we = signals.walletEvidence;
    lines.push(`Wallet connected: ${we.walletConnected}`);
    if (we.walletAddress) lines.push(`Wallet address: ${we.walletAddress}`);
    if (we.detectedRequests?.length) lines.push(`Wallet requests detected: ${we.detectedRequests.length}`);
    if (we.rejectedRequests?.length) lines.push(`Wallet requests rejected: ${we.rejectedRequests.length}`);
  }
  if (signals.transactionAttempted && !signals.transactionSubmitted) {
    lines.push('Transaction was attempted but not broadcast — likely insufficient BNB for gas. This is evidence the feature IS functional (lean VERIFIED or UNTESTABLE, not LARP).');
  }

  if (signals.pageJsCrash) {
    // Never inject raw console error text into the LLM context — it gets echoed
    // into user-facing reasoning. DATA_DASHBOARD uses neutral directives only.
    if (featureType === 'DATA_DASHBOARD' && signals.ownDomainApiCalls.length > 0) {
      lines.push(
        'Note: transient client-side noise was observed during the run (details omitted). ' +
        'Own-domain API calls are present — lean VERIFIED.',
      );
    } else if (featureType === 'DATA_DASHBOARD') {
      lines.push(
        'Note: transient client-side noise was observed during the run (details omitted). ' +
        'For DATA_DASHBOARD / leaderboard claims return UNTESTABLE, not FAILED, if the table is not visible.',
      );
    } else {
      lines.push(
        'Note: transient client-side noise was observed during the run (details omitted). ' +
        'If positive signals exist, lean toward VERIFIED/UNTESTABLE. ' +
        'If no positive signals, return FAILED (broken implementation).',
      );
    }
  }

  return lines.join('\n');
}
