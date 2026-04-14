import OpenAI from 'openai';
import type { AgentObservation, AgentStep, AttemptMemory, PageState } from './types';
import { SOCIAL_HANDLE_FILL_TOKEN, INVESTIGATION_WALLET_FILL_TOKEN } from './constants';
import { getFeaturePlaybook, rankCtaCandidates, rankRouteCandidates } from './playbooks';
import { buildWorkflowHypothesis } from './workflow';
import { formatRunMemoryContext } from './run-memory';
import type { RunMemory } from './run-memory';

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
- { "action": "fill_input",        "selector": "CSS input selector", "value": "text to type" } — for social / username fields use value exactly "${SOCIAL_HANDLE_FILL_TOKEN}" (substituted with hardcoded handle in executor)
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

  lines.push(`\nPage content (first 1500 chars):\n${ps.visibleText.slice(0, 1500)}`);

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

// ─────────────────────────────────────────────────────────────────────────────
// extractPassConditionPaths — parse URL paths explicitly mentioned in the
// pass condition string (e.g. "Navigate to /autonomous-economy and /agentic_bot").
// These are authoritative navigation targets from the claim author.
//
// Rules to avoid false positives:
//  - Only lowercase paths (real routes are lowercase; "URLs", "BNB" etc. are not)
//  - Minimum 3 chars after the slash
//  - Not a common English word fragment (to, on, in, at, etc.)
// ─────────────────────────────────────────────────────────────────────────────
const PASS_CONDITION_PATH_STOPLIST = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'or', 'and',
  'its', 'api', 'app', 'web', 'new', 'use', 'all', 'via', 'bot', 'log',
  'top', 'run', 'get', 'set', 'put', 'out', 'one', 'two', 'now', 'how',
  'not', 'but', 'has', 'had', 'did', 'can', 'may', 'own', 'way', 'day',
]);

function extractPassConditionPaths(passCondition: string): string[] {
  // Only match lowercase paths (real routes are lowercase)
  const matches = passCondition.match(/\/[a-z][a-z0-9_-]{2,}/g) ?? [];
  return [...new Set(matches)].filter((p) =>
    p.length > 3 &&
    p.length < 80 &&
    !PASS_CONDITION_PATH_STOPLIST.has(p.slice(1)),
  );
}

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
  /** Accumulated knowledge from Plan A — injected as RUN CONTEXT so the planner
   *  knows what was already discovered (visited routes, auth status, wallet state). */
  runMemory?: RunMemory,
): Promise<AgentStep[]> {
  console.log('[planner] Planning workflow...');
  console.log('[planner] Blockers:', pageState.blockers);
  console.log('[planner] Route candidates:', pageState.routeCandidates);

  // ── Inject pass-condition paths as high-priority candidate routes ──────────
  // The pass condition often names specific URL paths that are authoritative
  // navigation targets (e.g. "Navigate to /autonomous-economy and /agentic_bot").
  // These are NOT "invented paths" — they come from the claim spec and must be
  // tried even if they don't appear in the scraped nav links.
  const passConditionPaths = extractPassConditionPaths(passCondition);
  if (passConditionPaths.length > 0) {
    console.log('[planner] Pass-condition paths:', passConditionPaths);
    for (const p of passConditionPaths) {
      if (!pageState.routeCandidates.includes(p)) {
        pageState.routeCandidates.unshift(p); // high priority
      }
    }
  }

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

  const featureGuidance = buildFeatureGuidance(featureType, strategy, connectedWalletAddress, passConditionPaths);
  const playbook = getFeaturePlaybook(featureType);
  const rankedRoutes = rankRouteCandidates(pageState, featureType, claim, undefined, surface);
  const rankedCtas = rankCtaCandidates(pageState, featureType, claim);
  const hypothesis = buildWorkflowHypothesis(claim, featureType, pageState);

  // Deterministic-first first action: route-first when a strong route exists.
  const deterministicFirstStep: AgentStep | undefined = (() => {
    // Highest priority: paths explicitly named in the pass condition
    // (e.g. "Navigate to /autonomous-economy and /agentic_bot").
    // These are authoritative — navigate there even if not in nav links.
    if (passConditionPaths.length > 0) {
      const current = pageState.url;
      // Find the first pass-condition path that doesn't match the current URL
      const firstUnvisited = passConditionPaths.find((p) => {
        try {
          const pn = new URL(current).pathname;
          return pn !== p && !pn.startsWith(p + '/');
        } catch { return true; }
      });
      if (firstUnvisited) {
        const navLabel = pageState.navLinks.find((n) => n.href === firstUnvisited)?.text;
        if (navLabel?.trim()) return { action: 'open_link_text', text: navLabel.trim() };
        return { action: 'navigate', path: firstUnvisited };
      }
    }
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

  const runMemoryNote = runMemory ? formatRunMemoryContext(runMemory) : '';

  const passConditionNote = passConditionPaths.length > 0
    ? `\nPASS-CONDITION PATHS (authoritative — navigate these even if not in nav links): ${passConditionPaths.join(', ')}`
    : '';

  const systemPrompt = `${BASE_SYSTEM}

FEATURE CONTEXT:
Feature type: ${featureType}
Verification strategy: ${strategy}
Configured surface: ${surface}
${walletConnectedNote}
${runMemoryNote ? `${runMemoryNote}\n` : ''}${featureGuidance}

PLANNING RULES (surface-finder mode — the ReAct loop handles interaction):
1. Your ONLY job is to navigate to the correct feature surface. Return 1-3 navigation steps MAX.
2. After navigation, an adaptive ReAct loop takes over — do NOT plan form fills, clicks, or checks.
3. Prefer open_link_text for nav links (works in any language), navigate for direct paths.
4. Use ONLY routes from Nav links, Available routes, or paths listed in PASS-CONDITION PATHS — NEVER invent other paths.
5. If the feature is on the current page (homepage workflow), return 0-1 steps.
6. Only return {"steps":[]} if the page is broken, auth-gated with no visible UI, or wallet_only_gate confirmed.
7. RESPONSE FORMAT: Return JSON {"steps":[...]} — no text outside the JSON object.${pageScreenshotDataUrl ? '\n8. A screenshot of the page is attached. Study it to identify the right navigation target.' : ''}${passConditionNote}`;

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
      model:           'gpt-4.1',
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

    // Inject remaining pass-condition paths as navigate steps after the first,
    // so the agent visits ALL explicitly-mentioned paths (e.g. /autonomous-economy AND /agentic_bot).
    if (passConditionPaths.length > 1) {
      const current = pageState.url;
      const alreadyPlanned = new Set(steps.flatMap((s) => 'path' in s ? [s.path] : []));
      for (const p of passConditionPaths.slice(1)) {
        if (alreadyPlanned.has(p)) continue;
        try {
          const pn = new URL(current).pathname;
          if (pn === p || pn.startsWith(p + '/')) continue;
        } catch { /* ok */ }
        steps.push({ action: 'navigate', path: p });
        if (steps.length >= 5) break; // keep plan concise
      }
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
  _passCondition:    string,
  _featureType:      string,
  surface:          string,
  _strategy:         string,
  _updatedPageState: PageState,
  _priorObservations: AgentObservation[],
  _memory?:          AttemptMemory,
  _connectedWalletAddress?: string,
  _runMemory?: RunMemory,
  _pageScreenshotDataUrl?: string,
): Promise<AgentStep[]> {
  // In the ReAct architecture, replanning is unnecessary — the ReAct loop
  // handles recovery adaptively. Return a minimal navigation to the surface
  // so the ReAct loop can take over from there.
  console.log('[planner] replanWorkflow called — returning minimal surface navigation for ReAct loop');
  if (surface && surface !== '/') {
    return [{ action: 'navigate', path: surface }];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature-specific guidance injected into the planner prompt
// ─────────────────────────────────────────────────────────────────────────────

function buildFeatureGuidance(
  featureType: string,
  strategy: string,
  connectedWallet?: string,
  passConditionPaths: string[] = [],
): string {
  const hasPassPaths = passConditionPaths.length > 0;
  const passPathsList = passConditionPaths.join(', ');

  switch (featureType) {
    case 'DATA_DASHBOARD':
    case 'dashboard+browser':
      // One consolidated case — never use passConditionPaths from the dead
      // duplicate that appeared below (that code was unreachable).
      if (hasPassPaths) {
        return `PRIORITY:
1. Navigate to EACH of these pass-condition paths in order: ${passPathsList}
   These are authoritative targets — navigate even if they are not in the nav links.
   Do NOT stop after the first path — visit ALL of them.
2. At each page, scroll down to reveal table rows, charts, stats, and data sections.
3. Verify that live data is visible: stats, counters, table rows, or chart data.`;
      }
      return `PRIORITY:
1. Your FIRST step must navigate to the leaderboard/dashboard route.
   — Use open_link_text with the exact nav link label visible in Nav links (e.g. "排行榜", "Leaderboard", "排名", "Stats", "Rankings").
   — OR use navigate with the href path shown in Nav links (e.g. navigate("/leaderboard")).
   — If no dedicated route exists, stay on the homepage and scroll to find counters/stats.
2. After arriving, scroll down to reveal the full table or chart content.
3. Verify that table column headers, data rows, or aggregate stats are visible on screen.`;

    case 'TOKEN_CREATION':
    case 'form+browser':
      return `PRIORITY — demonstrate token/agent creation.

Social handles and username fields:
- When a field is labeled X/Twitter/GitHub/TikTok/Twitch Username, social handle, or similar,
  fill it with a short alphanumeric test handle (e.g. "testbot01", max 15 chars, no spaces).
- If "Enable Fee Sharing" is on, keep it enabled and fill the username field.
- Do NOT leave social/username fields empty — that will cause a validation error.
- Read the field's placeholder text as a FORMAT HINT only — never copy it verbatim.
- If a name/handle is "already taken", append a digit and try again.

Workflow:${hasPassPaths ? `\n0. Navigate to: ${passPathsList}` : ''}
1. Navigate to the token/agent creation form.
2. Fill ALL visible fields top-to-bottom: name (short, max 15 chars), symbol, description.
   For URL fields: use "https://docs.example.com" unless placeholder says "ipfs" — then use
   "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG".
3. Scroll down 600px; fill any newly revealed fields the same way.
4. Image uploads are automatic — do not click upload.
5. Click the final submit button ("Create", "Launch", "Deploy", "Mint", "Create Agent").
${connectedWallet ? `\nCONNECTED WALLET: ${connectedWallet}
If a field explicitly expects a 0x wallet address as fee recipient, use fill_input value exactly: ${INVESTIGATION_WALLET_FILL_TOKEN}` : ''}`;

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
      if (hasPassPaths) {
        return `PRIORITY: Navigate to EACH of these paths in order: ${passPathsList}
At each page, look for agent lifecycle data: list of active agents, models, inference providers,
status indicators, activity feeds, or competition rankings.
If you see a "Deploy Agent" or "Create Agent" button, click it to show the deployment form.
Stop before any transaction submission.`;
      }
      return 'PRIORITY: Navigate to the agent management surface. Look for agent lifecycle data: list of active agents, models, inference providers, status indicators, activity feeds, or competition rankings. If you see a "Deploy Agent" or "Create Agent" button, click it to show the deployment form. Stop before any transaction submission.';

    default:
      return `PRIORITY: Navigate to the most relevant page for this claim → interact with primary CTAs → observe state changes.${hasPassPaths ? ` Visit ALL pass-condition paths: ${passPathsList}` : ''}`;
  }
}
