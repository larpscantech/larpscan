import OpenAI from 'openai';
import type { AgentObservation, AgentStep, AttemptMemory, PageState } from './types';
import { FEE_SHARE_SOCIAL_HANDLE_FILL_TOKEN, INVESTIGATION_WALLET_FILL_TOKEN } from './constants';
import { getFeaturePlaybook, rankCtaCandidates, rankRouteCandidates } from './playbooks';
import { buildWorkflowHypothesis } from './workflow';

function countSemanticNoops(memory: AttemptMemory | undefined, prefix: string): number {
  if (!memory) return 0;
  return memory.noopActions.filter((s) => s.startsWith(prefix)).length;
}

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (_openai) return _openai;
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  _openai = new OpenAI({ apiKey: key });
  return _openai;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared system prompt foundation
// ─────────────────────────────────────────────────────────────────────────────

const BASE_SYSTEM = `You are a browser QA agent for a blockchain product verifier.

Your job is to DEMONSTRATE whether a product claim is true by navigating the site and gathering strong evidence.

AVAILABLE ACTIONS (JSON format):
- { "action": "navigate",          "path": "/route-to-visit" }
- { "action": "open_link_text",    "text": "link label text" }  (follows a[href] — use for nav links)
- { "action": "scroll",            "direction": "down", "amount": 600 }
- { "action": "click_text",        "text": "button or CTA text" }
- { "action": "click_selector",    "selector": "CSS selector" }
- { "action": "fill_input",        "selector": "CSS input selector", "value": "text to type" } — for social fee-sharing username fields use value exactly "${FEE_SHARE_SOCIAL_HANDLE_FILL_TOKEN}" (substituted with hardcoded handle in executor)
- { "action": "wait_for_selector", "selector": "CSS selector" }
- { "action": "wait_for_text",     "text": "text to wait for" }
- { "action": "back" }
- { "action": "check_text",        "text": "text expected on CURRENT page AFTER interaction" }

SAFETY RULES — NEVER do any of these:
- click or interact with: "Sign", "Approve", "Confirm transaction", "Swap" (execution), "Buy", "Sell", "Pay"
- Traditional Chinese equivalents: "簽名", "簽署", "批准", "確認交易", "執行兌換", "購買", "出售", "支付"
- enter seed phrases, private keys, 助記詞, or 私鑰
- trigger real blockchain transactions

WALLET CONNECTION — when the investigation wallet is configured:
- You ARE allowed to click "Connect Wallet", "Connect Wallet to Continue", "連接錢包" buttons
- The system will handle the wallet connection automatically after you click
- After clicking a connect button, continue with the next step — the wallet mock handles authentication
- If a page shows "Connect Wallet to Continue" as the only way forward, click it

EXCEPTION — For TOKEN_CREATION claims, you ARE allowed to:
- click the final "Create Token", "Launch Token", "Deploy", "Mint", "Create" submit button
- the investigation wallet will handle the transaction safely (it may result in "not enough gas" — that IS valid evidence)
- do NOT click "Approve", "Sign", or "Confirm transaction" on any other wallet popup after the submit

MULTILINGUAL PAGES:
- The site UI may be in Traditional Chinese (繁體中文), Simplified Chinese, or other languages
- Read button text and labels regardless of language
- Treat Chinese action buttons exactly like their English equivalents
- Scroll down to find content that may be below the fold — Chinese sites often stack sections vertically

EVIDENCE HIERARCHY (strongest first):
1. URL/route change after interaction
2. Modal or form appeared
3. Network/API activity triggered
4. New section / table / dashboard content visible
5. Inputs filled and form interactive
6. check_text confirmation (supporting only, max 1 per plan)

WALLET HANDLING:
- If "Connect Wallet" / "連接錢包" is visible but the feature form/UI is ALSO visible — proceed to demonstrate the form
- Stop before any wallet signature step (Sign / 簽名 / 簽署 / Approve / 批准)
- Do not stop just because a wallet prompt exists on the page

NAVIGATION PRIORITY:
- If Nav links or Available routes contain a path relevant to the claim, your FIRST step must navigate there.
- Use open_link_text with the exact nav link label (works for any language including Chinese, e.g. "排行榜", "Leaderboard").
- Use navigate with the href path as a fallback if open_link_text is unavailable.
- Do NOT scroll the current page looking for content that lives on a different route.
- Do NOT assume the homepage contains the feature — check Nav links first.

Return ONLY a JSON array of steps. No explanation, no markdown.`;

// ─────────────────────────────────────────────────────────────────────────────
// Format PageState into a compact context block for the LLM
// ─────────────────────────────────────────────────────────────────────────────

function formatPageContext(ps: PageState): string {
  const lines: string[] = [];

  lines.push(`Current URL: ${ps.url}`);
  lines.push(`Page title: ${ps.title}`);

  if (ps.blockers.length > 0) {
    lines.push(`⚠ Blockers detected: ${ps.blockers.join(', ')}`);
  }

  if (ps.navLinks.length > 0) {
    lines.push(`Nav links:\n${ps.navLinks.slice(0, 10).map((l) => `  ${l.href ?? '?'} → "${l.text}"`).join('\n')}`);
  }

  if (ps.routeCandidates.length > 0) {
    lines.push(`Available routes: ${ps.routeCandidates.join(', ')}`);
  }
  if ((ps.rankedRoutes?.length ?? 0) > 0) {
    lines.push(
      `Ranked routes (deterministic-first):\n${(ps.rankedRoutes ?? [])
        .slice(0, 8)
        .map((r) => `  ${r.path} [score=${r.score}] (${r.reason})`)
        .join('\n')}`,
    );
  }

  if (ps.buttons.length > 0) {
    const btns = ps.buttons.slice(0, 12).map((b) => `  ${b.isPrimary ? '[PRIMARY]' : ''}${b.disabled ? '[DISABLED]' : ''} "${b.text}"`);
    lines.push(`Buttons:\n${btns.join('\n')}`);
  }

  if (ps.forms.length > 0) {
    for (const form of ps.forms.slice(0, 3)) {
      // Format as ready-to-use CSS selectors for fill_input actions
      const inputDesc = form.inputs
        .filter((i) => i.type !== 'hidden' && i.type !== 'submit' && i.type !== 'range')
        .map((i) => {
          const sel =
            i.name ? `[name="${i.name}"]`
              : i.placeholder ? `[placeholder="${i.placeholder}"]`
                : `input[type="${i.type}"]`;
          const lab = (i.label ?? '').replace(/\s+/g, ' ').trim();
          return lab ? `${sel} (label: ${lab.slice(0, 72)})` : sel;
        })
        .join(', ');
      lines.push(`Form fields (use as fill_input selectors — fill EVERY empty text field, including social fee-sharing usernames): ${inputDesc}`);
    }
  }

  if (ps.headings.length > 0) {
    lines.push(`Headings: ${ps.headings.slice(0, 6).join(' | ')}`);
  }

  if (ps.sectionLabels.length > 0) {
    lines.push(`Sections: ${ps.sectionLabels.slice(0, 6).join(' | ')}`);
  }

  if (ps.tableHeaders.length > 0) {
    lines.push(`Table headers: ${ps.tableHeaders.join(', ')}`);
  }

  if (ps.chartSignals.length > 0) {
    lines.push(`Chart signals: ${ps.chartSignals.join(', ')}`);
  }

  if (ps.ctaCandidates.length > 0) {
    lines.push(`Visible CTAs: ${ps.ctaCandidates.slice(0, 6).map((c) => `"${c.text}"`).join(', ')}`);
  }
  if ((ps.rankedCtas?.length ?? 0) > 0) {
    lines.push(
      `Ranked CTAs (deterministic-first):\n${(ps.rankedCtas ?? [])
        .slice(0, 8)
        .map((c) => `  "${c.text}" [score=${c.score}] (${c.reason})`)
        .join('\n')}`,
    );
  }

  if (ps.hasModal) {
    lines.push('⚠ A modal/dialog is currently open');
  }

  // Accessibility tree — the most reliable source for interactive elements.
  // Gives exact roles and names as the browser's own representation.
  if ((ps.axInteractive?.length ?? 0) > 0) {
    const axLines = (ps.axInteractive ?? [])
      .map((n) => {
        const flags: string[] = [];
        if (n.disabled)            flags.push('DISABLED');
        if (n.required)            flags.push('REQUIRED');
        if (n.checked === true)    flags.push('CHECKED');
        if (n.expanded === true)   flags.push('EXPANDED');
        if (n.value)               flags.push(`value="${n.value}"`);
        const flagStr = flags.length > 0 ? ` [${flags.join('|')}]` : '';
        return `  [${n.role}] "${n.name}"${flagStr}`;
      })
      .join('\n');
    lines.push(`Accessibility tree (interactive elements — use names for click_text targets):\n${axLines}`);
  }

  lines.push(`\nPage content (first 700 chars):\n${ps.visibleText.slice(0, 700)}`);

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse and validate LLM response into AgentStep[]
//
// Handles three formats the model might return:
//   1. { "steps": [...] }  — structured JSON object (preferred, used with json_object)
//   2. [...]               — bare array (legacy fallback)
//   3. {..., "steps": []}  — object with empty steps = no plan
// ─────────────────────────────────────────────────────────────────────────────

function parseSteps(raw: string, max: number): AgentStep[] {
  const text = raw.trim();
  try {
    const parsed = JSON.parse(text) as
      | { steps?: AgentStep[]; plan?: AgentStep[] }
      | AgentStep[];

    // Structured object: { steps: [...] } or { plan: [...] }
    if (!Array.isArray(parsed)) {
      const arr = parsed.steps ?? parsed.plan ?? [];
      return Array.isArray(arr) ? arr.filter(Boolean).slice(0, max) : [];
    }
    // Bare array
    return parsed.filter(Boolean).slice(0, max);
  } catch {
    // Fallback: extract first JSON array from the string (handles prose + JSON)
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    try {
      const arr = JSON.parse(match[0]) as AgentStep[];
      return Array.isArray(arr) ? arr.filter(Boolean).slice(0, max) : [];
    } catch {
      console.error('[planner] Failed to parse steps from response:', text.slice(0, 200));
      return [];
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// planWorkflow — initial plan based on live page state + claim context
// ─────────────────────────────────────────────────────────────────────────────

export async function planWorkflow(
  claim:         string,
  passCondition: string,
  featureType:   string,
  surface:       string,
  strategy:      string,
  pageState:     PageState,
  /** When set, TOKEN_CREATION guidance includes wallet + fill token for 0x recipient fields */
  connectedWalletAddress?: string,
  /** JPEG data URL of the current page — gives the LLM visual context so it
   *  plans like a human who SEES the page, not just reads its text. */
  pageScreenshotDataUrl?: string,
): Promise<AgentStep[]> {
  console.log('[planner] Planning workflow...');
  console.log('[planner] Blockers:', pageState.blockers);
  console.log('[planner] Route candidates:', pageState.routeCandidates);

  // Hard early-return conditions.
  // auth_required only hard-stops when there is truly NO interactive UI — if CTAs
  // or buttons are visible the agent can still demonstrate the feature surface.
  const hasVisibleUi =
    pageState.ctaCandidates.length > 0 ||
    pageState.buttons.filter((b) => !b.disabled).length > 0 ||
    pageState.forms.length > 0;

  const hardStop =
    (pageState.blockers.includes('auth_required') && !hasVisibleUi) ||
    pageState.blockers.includes('page_broken') ||
    pageState.blockers.includes('bot_protection');

  if (hardStop) {
    console.log('[planner] Hard stop — returning empty plan', {
      auth_required: pageState.blockers.includes('auth_required'),
      page_broken:   pageState.blockers.includes('page_broken'),
      bot_protection: pageState.blockers.includes('bot_protection'),
      hasVisibleUi,
    });
    return [];
  }

  const featureGuidance = buildFeatureGuidance(featureType, strategy, connectedWalletAddress);
  const playbook = getFeaturePlaybook(featureType);
  const rankedRoutes = rankRouteCandidates(pageState, featureType, claim, undefined, surface);
  const rankedCtas = rankCtaCandidates(pageState, featureType, claim);
  const hypothesis = buildWorkflowHypothesis(claim, featureType, pageState);

  // Deterministic-first first action: route-first when a strong route exists.
  const deterministicFirstStep: AgentStep | undefined = (() => {
    if (surface && surface !== '/' && pageState.routeCandidates.includes(surface)) {
      const navLabel = pageState.navLinks.find((n) => n.href === surface)?.text;
      if (navLabel && navLabel.trim().length > 0) return { action: 'open_link_text', text: navLabel.trim() };
      return { action: 'navigate', path: surface };
    }
    const rootScopedClaim =
      surface === '/' &&
      /(mine|mining|hash|worker|pool|lottery|挖礦|雜湊|算力|礦池|獎池)/i.test(claim);
    if (rootScopedClaim) {
      const miningCta = rankedCtas.find((c) => /(mine|mining|start|generate|launch|挖礦|開始|生成|啟動)/i.test(c.text));
      if (miningCta && miningCta.score >= 2) return { action: 'click_text', text: miningCta.text };
    }
    const bestRoute = rankedRoutes[0];
    if (bestRoute && bestRoute.path !== '/' && bestRoute.score >= 3) {
      const navLabel = pageState.navLinks.find((n) => n.href === bestRoute.path)?.text;
      if (navLabel && navLabel.trim().length > 0) {
        return { action: 'open_link_text', text: navLabel.trim() };
      }
      return { action: 'navigate', path: bestRoute.path };
    }
    const bestCta = rankedCtas[0];
    if (bestCta && bestCta.score >= 3) return { action: 'click_text', text: bestCta.text };
    return hypothesis.firstMeaningfulAction;
  })();

  const walletConnectedNote = connectedWalletAddress
    ? `\nWALLET STATUS: ALREADY CONNECTED (address: ${connectedWalletAddress}). The investigation wallet is live in the browser. DO NOT plan any "Connect Wallet", "connect wallet", or wallet-modal steps — the wallet is connected and those steps will be no-ops. Skip directly to interacting with the feature (fill forms, click CTAs, observe results).\n`
    : '';

  const systemPrompt = `${BASE_SYSTEM}

FEATURE CONTEXT:
Feature type: ${featureType}
Verification strategy: ${strategy}
Configured surface: ${surface}
${walletConnectedNote}
${featureGuidance}

PLANNING RULES:
1. Treat this claim as a complete workflow: navigate → interact → observe result
2. Maximum 10 steps total
3. Deterministic-first policy: prefer the ranked routes and ranked CTAs provided in context. Use LLM judgment only to pick among top-ranked candidates or when ranked options fail.
4. If Configured surface is non-root and Nav links contain a matching route, your FIRST step must navigate there using open_link_text (preferred — works in any language) or navigate with the href. If Configured surface is "/" and the claim is homepage workflow (e.g. mining/hash/start), prefer local CTA/form actions first. Use ONLY routes from Nav links or Available routes — NEVER invent paths
5. Prefer ctaCandidates and non-disabled buttons for click targets
6. check_text is supporting evidence only — maximum 1 step, only at the very end
7. If blockers include wallet_required but form/dashboard UI is visible — still plan steps to demonstrate it
8. For DATA_DASHBOARD / dashboard+browser: use navigate → scroll → inspect table/chart content
9. For TOKEN_CREATION / form+browser: navigate → fill ALL visible form fields using selectors from "Form fields" → scroll down → fill remaining fields → click the Create/Launch/Deploy/Mint submit button → check_text for the outcome. You ARE allowed to click the submit button for TOKEN_CREATION. NEVER invent input selectors — only use what is listed in "Form fields".
10. For DEX_SWAP / WALLET_FLOW: navigate to feature surface → click "Connect Wallet" if it blocks access → show form is interactive → stop before wallet signature (Sign/Approve)
11. Only return {"steps":[]} if the page is broken, auth-gated with no visible UI, or wallet_only_gate confirmed
12. RESPONSE FORMAT: Return JSON {"steps":[...]} — no text outside the JSON object.${pageScreenshotDataUrl ? '\n13. A screenshot of the page is attached. Study it carefully before planning — look for visible forms, buttons, and loaded content.' : ''}`;

  const userText = [
    `Claim: ${claim}`,
    `Pass condition: ${passCondition}`,
    `Playbook route keywords: ${playbook.routeKeywords.join(', ')}`,
    `Playbook CTA keywords: ${playbook.ctaKeywords.join(', ')}`,
    `Hypothesis likely surface: ${hypothesis.likelySurface ?? 'n/a'}`,
    `Hypothesis first meaningful action: ${hypothesis.firstMeaningfulAction ? JSON.stringify(hypothesis.firstMeaningfulAction) : 'n/a'}`,
    `Top ranked routes: ${rankedRoutes.slice(0, 5).map((r) => `${r.path}(${r.score})`).join(', ') || 'none'}`,
    `Top ranked CTAs: ${rankedCtas.slice(0, 5).map((c) => `"${c.text}"(${c.score})`).join(', ') || 'none'}`,
    '',
    formatPageContext(pageState),
  ].join('\n');

  type PlanContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail: 'low' } };

  const userContent: PlanContentPart[] | string = pageScreenshotDataUrl
    ? [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: pageScreenshotDataUrl, detail: 'low' } },
      ]
    : userText;

  try {
    const resp = await getOpenAI().chat.completions.create({
      model:           'gpt-4o',
      temperature:     0,
      max_tokens:      900,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: 'user',   content: userContent as any },
      ],
    });

    const raw   = resp.choices[0]?.message?.content ?? '[]';
    let steps = parseSteps(raw, 10);

    // Deterministic-first enforcement: ensure first step is meaningful route/cta
    if (deterministicFirstStep && steps.length > 0) {
      const first = steps[0];
      const firstIsMeaningfulNav =
        (first.action === 'navigate' && first.path !== '/') ||
        first.action === 'open_link_text';
      if (!firstIsMeaningfulNav) {
        steps = [deterministicFirstStep, ...steps].slice(0, 10);
      }
    } else if (deterministicFirstStep && steps.length === 0) {
      steps = [deterministicFirstStep];
    }

    console.log(`[planner] Plan A: ${steps.length} step(s)`, JSON.stringify(steps, null, 2));
    return steps;
  } catch (e) {
    console.error('[planner] planWorkflow failed:', e);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// replanWorkflow — recovery plan when initial steps produced no meaningful progress
// ─────────────────────────────────────────────────────────────────────────────

export async function replanWorkflow(
  claim:            string,
  passCondition:    string,
  featureType:      string,
  surface:          string,
  strategy:         string,
  updatedPageState: PageState,
  priorObservations: AgentObservation[],
  memory?:          AttemptMemory,
  connectedWalletAddress?: string,
): Promise<AgentStep[]> {
  console.log('[planner] Replanning — generating recovery plan...');

  // Split prior observations into effective steps (produced observable change)
  // and true no-ops (produced no change). Previously everything was labeled
  // "NO-OP" which confused the model about what was actually attempted.
  const effectiveSteps = priorObservations
    .filter((o) => !o.isNoop)
    .map((o, i) => `  ${i + 1}. ${o.step} → ${o.result ?? 'ok'}`)
    .join('\n') || '  (none)';

  const noopSteps = priorObservations
    .filter((o) => o.isNoop)
    .map((o) => `  • ${o.step}`)
    .join('\n') || '  (none)';

  const noopSummary = `Steps that had observable effect:\n${effectiveSteps}\n\nSteps that were no-ops (try something different):\n${noopSteps}`;

  const tokenVaultRecovery =
    featureType === 'TOKEN_CREATION'
      ? `
TOKEN_CREATION / FEE SHARING RECOVERY:
- If you see "Please enter a username for fee sharing" (or similar validation error), fill the X/Twitter username field using EXACT selector from Form fields and value exactly: ${FEE_SHARE_SOCIAL_HANDLE_FILL_TOKEN}
- Do NOT disable the fee-sharing toggle — keep it enabled and fill the username.
${connectedWalletAddress ? `Connected wallet: ${connectedWalletAddress}. For explicit 0x recipient fields use: ${INVESTIGATION_WALLET_FILL_TOKEN}` : ''}
`
      : '';

  const walletConnectedNoteReplan = connectedWalletAddress
    ? `\nWALLET STATUS: ALREADY CONNECTED (address: ${connectedWalletAddress}). DO NOT plan wallet-connection steps — skip directly to the feature workflow.\n`
    : '';

  const systemPrompt = `${BASE_SYSTEM}

FEATURE CONTEXT:
Feature type: ${featureType}
Verification strategy: ${strategy}
Configured surface: ${surface}
${walletConnectedNoteReplan}${tokenVaultRecovery}
RECOVERY PLANNING RULES:
1. The previous steps produced no meaningful progress — try a DIFFERENT approach
2. Maximum 5 steps
3. Suggested recovery strategies:
   - Navigate to a different route from the available routes list
   - Scroll down to reveal hidden content or lazy-loaded UI
   - Look for an alternative CTA or entry point
   - Try open_link_text for a nav link related to the claim
   - Navigate to homepage and approach from a different angle
4. Do NOT repeat attempted routes, attempted CTAs, or steps already known as no-op
5. check_text max 1 at the end only
6. Use ONLY routes from available routes — never invent paths
7. Deterministic-first: choose next highest-ranked unattempted route/CTA before free-form exploration
8. RESPONSE FORMAT: Return JSON {"steps":[...]} — no text outside the JSON object`;

  const rankedRoutes = rankRouteCandidates(updatedPageState, featureType, claim, {
    attemptedRoutes: memory?.attemptedRoutes,
    attemptedCtas: memory?.attemptedCtas,
    noopActions: memory?.noopActions,
  }, surface);
  const rankedCtas = rankCtaCandidates(updatedPageState, featureType, claim, {
    attemptedRoutes: memory?.attemptedRoutes,
    attemptedCtas: memory?.attemptedCtas,
    noopActions: memory?.noopActions,
  });
  const dashboardNoops = countSemanticNoops(memory, 'route_class:dashboard') + countSemanticNoops(memory, 'cta_class:dashboard');
  const creationNoops = countSemanticNoops(memory, 'route_class:creation') + countSemanticNoops(memory, 'cta_class:creation');
  const walletFlowNoops = countSemanticNoops(memory, 'route_class:wallet_flow') + countSemanticNoops(memory, 'cta_class:wallet_flow');
  const untriedRoute = rankedRoutes.find((r) => !memory?.attemptedRoutes.includes(r.path));
  const untriedCta = rankedCtas.find((c) => !memory?.attemptedCtas.includes(c.text));
  let deterministicRecoveryStep: AgentStep | undefined;
  // Semantic pivot: avoid repeating the same failing action class cluster.
  if (
    (featureType === 'DATA_DASHBOARD' && dashboardNoops >= 2) ||
    (featureType === 'TOKEN_CREATION' && creationNoops >= 2) ||
    ((featureType === 'WALLET_FLOW' || featureType === 'DEX_SWAP') && walletFlowNoops >= 2)
  ) {
    deterministicRecoveryStep = updatedPageState.forms.length > 0
      ? { action: 'scroll', direction: 'down', amount: 700 }
      : (untriedCta ? { action: 'click_text', text: untriedCta.text } : undefined);
  } else {
    deterministicRecoveryStep = untriedRoute
      ? { action: 'navigate', path: untriedRoute.path }
      : (untriedCta ? { action: 'click_text', text: untriedCta.text } : undefined);
  }

  const userMessage = [
    `Claim: ${claim}`,
    `Pass condition: ${passCondition}`,
    '',
    'STEPS ALREADY ATTEMPTED:',
    noopSummary,
    '',
    `Attempted routes: ${(memory?.attemptedRoutes ?? []).join(', ') || 'none'}`,
    `Attempted CTAs: ${(memory?.attemptedCtas ?? []).join(', ') || 'none'}`,
    `No-op actions: ${(memory?.noopActions ?? []).join(' | ') || 'none'}`,
    `No-op class counts: dashboard=${dashboardNoops}, creation=${creationNoops}, wallet_flow=${walletFlowNoops}`,
    `Top ranked untried route: ${untriedRoute ? `${untriedRoute.path}(${untriedRoute.score})` : 'none'}`,
    `Top ranked untried CTA: ${untriedCta ? `${untriedCta.text}(${untriedCta.score})` : 'none'}`,
    '',
    'UPDATED PAGE STATE:',
    formatPageContext(updatedPageState),
  ].join('\n');

  try {
    const resp = await getOpenAI().chat.completions.create({
      model:           'gpt-4o',
      temperature:     0.1,   // slight variation to encourage different approach
      max_tokens:      600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage },
      ],
    });

    const raw   = resp.choices[0]?.message?.content ?? '{"steps":[]}';
    let steps = parseSteps(raw, 5);
    if (deterministicRecoveryStep) {
      const first = steps[0];
      const sameAsDeterministic = first && JSON.stringify(first) === JSON.stringify(deterministicRecoveryStep);
      if (!sameAsDeterministic) {
        steps = [deterministicRecoveryStep, ...steps].slice(0, 5);
      }
    }
    // Avoid repeating known no-op steps from memory.
    if (memory && memory.noopActions.length > 0) {
      const normalizedNoops = new Set(memory.noopActions);
      steps = steps.filter((s) => !normalizedNoops.has(stepToSignature(s)));
    }
    console.log(`[planner] Plan B (recovery): ${steps.length} step(s)`, JSON.stringify(steps, null, 2));
    return steps;
  } catch (e) {
    console.error('[planner] replanWorkflow failed:', e);
    return [];
  }
}

function stepToSignature(step: AgentStep): string {
  switch (step.action) {
    case 'navigate':          return `navigate("${step.path}")`;
    case 'open_link_text':    return `open_link_text("${step.text}")`;
    case 'click_text':        return `click_text("${step.text}")`;
    case 'click_selector':    return `click_selector("${step.selector}")`;
    case 'fill_input':        return `fill_input("${step.selector}", "${step.value}")`;
    case 'wait_for_selector': return `wait_for_selector("${step.selector}")`;
    case 'wait_for_text':     return `wait_for_text("${step.text}")`;
    case 'scroll':            return `scroll(${step.direction}, ${step.amount ?? 600}px)`;
    case 'back':              return 'back()';
    case 'check_text':        return `check_text("${step.text}")`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature-specific guidance injected into the planner prompt
// ─────────────────────────────────────────────────────────────────────────────

function buildFeatureGuidance(
  featureType: string,
  strategy: string,
  connectedWallet?: string,
): string {
  switch (featureType) {
    case 'DATA_DASHBOARD':
    case 'dashboard+browser':
      return `PRIORITY:
1. Your FIRST step must navigate to the leaderboard/dashboard route.
   — Use open_link_text with the exact nav link label visible in Nav links (e.g. "排行榜", "Leaderboard", "排名", "Stats", "Rankings").
   — OR use navigate with the href path shown in Nav links (e.g. navigate("/leaderboard")).
   — Do NOT scroll the homepage — the table is on a dedicated sub-page.
2. After arriving on the leaderboard/dashboard page, scroll down to reveal the full table or chart content.
3. Verify that table column headers and data rows are visible on screen.`;
    case 'TOKEN_CREATION':
    case 'form+browser':
      return `PRIORITY — demonstrate token creation with fee sharing enabled.

Fee sharing / social handles (BNBshare, Flap-style launchpads):
- When "Enable Fee Sharing" is on and a field is labeled X/Twitter/GitHub/TikTok/Twitch Username (or similar), fill it using value EXACTLY: ${FEE_SHARE_SOCIAL_HANDLE_FILL_TOKEN} (executor substitutes a hardcoded real handle).
- Do NOT disable the fee-sharing toggle — leave it on and fill the username so the social vault path is used.
- Do NOT leave the username field empty — that will cause a validation error ("Please enter a username for fee sharing") and the form will not submit.

Workflow:
1. Navigate to the token creation form.
2. Fill name "TestToken", symbol "TST", description, optional website/telegram — EXACT selectors from "Form fields".
3. Fill every visible social / fee-sharing username field with ${FEE_SHARE_SOCIAL_HANDLE_FILL_TOKEN}.
4. Scroll down 600px; fill any newly revealed fields the same way.
5. Image uploads are automatic — do not click upload.
6. Click "Create Token" / "Launch" / "Deploy" submit; use check_text for the outcome.
${connectedWallet ? `
CONNECTED VERIFICATION WALLET: ${connectedWallet}
If a field explicitly expects a 0x wallet address as fee recipient (not @username), use fill_input value exactly: ${INVESTIGATION_WALLET_FILL_TOKEN}` : ''}`;
    case 'DEX_SWAP':
    case 'ui+rpc':
      return 'PRIORITY: Navigate to the swap/exchange surface → show the swap form is present and interactive → identify token selectors and amount inputs (stop before executing any swap).';
    case 'WALLET_FLOW':
    case 'wallet+rpc':
      return 'PRIORITY: Navigate to the feature surface → click "Connect Wallet" if it blocks progress → demonstrate the UI and form structure → record available inputs (stop before Sign/Approve).';
    case 'API_FEATURE':
    case 'api+fetch':
      return 'PRIORITY: Navigate to the feature surface → look for API endpoint documentation, interactive demos, or direct endpoint responses.';
    case 'AGENT_LIFECYCLE':
    case 'MULTI_AGENT':
      return 'PRIORITY: Navigate to the agents/dashboard/activity surface → look for a list of active agents, lifecycle logs, activity feeds, or agent status indicators. If a "Deploy Agent" or "Create Agent" button is visible, click it to show the deployment form exists. Stop before any transaction submission.';
    default:
      return 'PRIORITY: Navigate to the most relevant page for this claim → interact with primary CTAs → observe state changes.';
  }
}
