import type { Page, BrowserContext } from 'playwright';
import OpenAI from 'openai';
import type { AgentObservation, AgentStep, BlockerType, PageMessage, PageState, WorkflowStage } from './types';
import type { NarrationSegment } from '../tts';
import { analyzePageState, capturePageText } from './page-analysis';
import {
  SOCIAL_HANDLE_FILL_TOKEN,
  SOCIAL_HANDLE_VALUE,
  HANDLE_FALLBACK_SEQUENCE,
  INVESTIGATION_WALLET_FILL_TOKEN,
} from './constants';
import type { WorkflowHypothesis } from './workflow';
import { classifyStepOutcome } from './workflow';
import { generateFakeTokenPng } from '../utils/fake-png';
import { triggerWalletReconnect, tryPickWalletInModal, autoReconnectWallet } from './wallet-reconnect';
import { dismissConsentBanner } from './evidence';
import { extractStructuredState, formatStateForLLM, type StructuredPageState } from './extract-state';
import { createMemory, updateMemory, formatMemoryForLLM, findDuplicateAction, type AgentMemory, type StepResult } from './executor-memory';

// ─────────────────────────────────────────────────────────────────────────────
// Safety guard
// ─────────────────────────────────────────────────────────────────────────────

// Always-blocked: credentials and high-risk approvals — never click regardless of claim type
const ALWAYS_BLOCKED_PATTERNS = [
  /seed phrase/i, /private key/i, /助記詞/, /私鑰/,
  /\bapprove\b/i, /\bauthorize\b/i, /批准/, /授權/,
  /confirm transaction/i, /確認交易/,
];

// Blocked by default but allowed for DEX_SWAP / WALLET_FLOW claims where trading IS the feature
const TRADING_PATTERNS = [
  /\bbuy\b/i, /\bsell\b/i, /execute swap/i, /\bswap\b/i, /\bpurchase\b/i,
  /購買代幣/, /出售代幣/, /執行兌換/,
];

// Signing is only blocked for non-trading, non-wallet flows
const SIGNING_PATTERNS = [/\bsign\b/i, /\bpay\b/i, /簽名/, /簽署/, /支付/];

function isSafeToInteract(text: string, featureType?: string): boolean {
  if (ALWAYS_BLOCKED_PATTERNS.some((re) => re.test(text))) return false;
  // For DEX_SWAP and WALLET_FLOW, trading and signing actions are EXPECTED — allow them
  if (featureType === 'DEX_SWAP' || featureType === 'WALLET_FLOW') return true;
  if (TRADING_PATTERNS.some((re) => re.test(text))) return false;
  if (SIGNING_PATTERNS.some((re) => re.test(text))) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// State-diff helpers
// ─────────────────────────────────────────────────────────────────────────────

async function hasModalOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dialogs = document.querySelectorAll('dialog, [role="dialog"]');
    for (const d of Array.from(dialogs)) {
      const s = window.getComputedStyle(d);
      if (s.display !== 'none' && s.visibility !== 'hidden') return true;
    }
    return false;
  }).catch(() => false);
}

async function getVisibleHeadings(page: Page): Promise<string[]> {
  return page.$$eval(
    'h1, h2, h3, h4',
    (els) => els.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean),
  ).catch(() => []);
}

async function getVisibleInputLabels(page: Page): Promise<string[]> {
  return page.$$eval(
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea',
    (els) => els
      .filter((el) => {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      })
      .map((el) => ((el as HTMLInputElement).name || (el as HTMLInputElement).placeholder || (el as HTMLInputElement).type || 'input').slice(0, 40)),
  ).catch(() => []);
}

async function getScrollY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY || window.pageYOffset || 0).catch(() => 0);
}

interface FormProgressSnapshot {
  inputCount: number;
  requiredCount: number;
  enabledSubmitCount: number;
  stepperHints: string[];
}

async function getFormProgressSnapshot(page: Page): Promise<FormProgressSnapshot> {
  return page.evaluate(() => {
    const visibleInputs = Array.from(document.querySelectorAll('input, textarea, select')).filter((el) => {
      const s = window.getComputedStyle(el as Element);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const rect = (el as HTMLElement).getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const requiredCount = visibleInputs.filter((el) => (el as HTMLInputElement).required).length;
    const enabledSubmitCount = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]')).filter((el) => {
      const s = window.getComputedStyle(el as Element);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const rect = (el as HTMLElement).getBoundingClientRect();
      const disabled = (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true';
      if (rect.width <= 0 || rect.height <= 0 || disabled) return false;
      const text = ((el as HTMLElement).innerText ?? el.textContent ?? '').toLowerCase();
      return /submit|continue|next|create|launch|generate|confirm|繼續|下一步|提交|送出|創建|生成|啟動|確認/.test(text);
    }).length;
    const stepperHints = Array.from(document.querySelectorAll('[aria-current="step"], .step.active, .wizard-step.active, [role="tab"][aria-selected="true"]'))
      .map((el) => ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 3);
    return {
      inputCount: visibleInputs.length,
      requiredCount,
      enabledSubmitCount,
      stepperHints,
    };
  }).catch(() => ({ inputCount: 0, requiredCount: 0, enabledSubmitCount: 0, stepperHints: [] }));
}

// ─────────────────────────────────────────────────────────────────────────────
// capturePageMessages — read what the page is explicitly telling the user.
//
// A human tester scans for toast notifications, alert banners, and status
// messages after every action. This gives the adaptive LLM the same signal:
// "The page said 'Twitter handle not found'" → don't click Mint, fix the handle.
// "The page said 'Token created successfully'" → the feature works, we're done.
// ─────────────────────────────────────────────────────────────────────────────

async function capturePageMessages(page: Page): Promise<PageMessage[]> {
  const raw = await page.evaluate((): { type: string; text: string }[] => {
    const seen  = new Set<string>();
    const out:  { type: string; text: string }[] = [];

    function push(type: string, text: string) {
      const clean = text.replace(/\s+/g, ' ').trim();
      if (!clean || clean.length < 6 || clean.length > 300) return;
      if (seen.has(clean)) return;
      seen.add(clean);
      out.push({ type, text: clean });
    }

    function classifyEl(el: Element): string {
      const cls   = (el.className + ' ' + el.getAttribute('role') + ' ' + el.id).toLowerCase();
      if (/error|danger|fail|invalid/.test(cls))   return 'error';
      if (/success|confirm|done|complete/.test(cls)) return 'success';
      if (/warn/.test(cls))                          return 'warning';
      return 'info';
    }

    // 1. ARIA live regions and alerts — highest signal
    for (const el of Array.from(document.querySelectorAll('[role="alert"], [role="status"], [aria-live]'))) {
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const text = (el as HTMLElement).innerText ?? '';
      push(classifyEl(el), text);
    }

    // 2. Toast/notification libraries (many naming conventions)
    const toastSelectors = [
      '[class*="toast" i]', '[class*="notification" i]',
      '[class*="snackbar" i]', '[class*="banner" i]',
      '[class*="alert" i]:not(script)',
    ];
    for (const sel of toastSelectors) {
      try {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') continue;
          const rect = (el as HTMLElement).getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          push(classifyEl(el), (el as HTMLElement).innerText ?? '');
        }
      } catch { /* ignore selector errors */ }
    }

    // 3. Inline form / field validation messages (visible small text near inputs)
    for (const el of Array.from(document.querySelectorAll(
      'p[class*="error" i], span[class*="error" i], div[class*="error" i], ' +
      'p[class*="helper" i], [class*="fieldError" i], [class*="form-error" i]',
    ))) {
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      push('error', (el as HTMLElement).innerText ?? '');
    }

    return out.slice(0, 6);
  }).catch(() => [] as { type: string; text: string }[]);
  return (raw as PageMessage[]);
}

// ─────────────────────────────────────────────────────────────────────────────
// buildStepNarrative — deterministic one-sentence summary of what a step did.
//
// These are strung together into a running history that is passed to
// decideAdaptiveStep, giving the model the same "mental model" a human tester
// builds while working through a multi-step flow.
// ─────────────────────────────────────────────────────────────────────────────

function buildStepNarrative(obs: AgentObservation): string {
  const parts: string[] = [`[${obs.step}]`];

  if (obs.urlChanged)                                 parts.push(`→ navigated to ${obs.url ?? 'new URL'}`);
  if (obs.modalOpened)                                parts.push('→ a modal/dialog opened');
  if (obs.newInputs?.length)                          parts.push(`→ new form fields appeared: ${obs.newInputs.join(', ')}`);
  if (obs.visibleSignals?.length)                     parts.push(`→ new content: ${obs.visibleSignals.join(', ')}`);
  if (obs.apiCalls?.length)                           parts.push(`→ ${obs.apiCalls.length} API call(s) fired`);
  if (obs.ctaStateChanged)                            parts.push('→ buttons changed state');
  if (obs.isNoop)                                     parts.push('→ no visible effect');
  if (obs.blockerDetected)                            parts.push(`→ ⚠ blocker: ${obs.blockerDetected}`);

  if (obs.messages?.length) {
    const msgStr = obs.messages
      .map((m) => `[${m.type.toUpperCase()}] "${m.text}"`)
      .join('; ');
    parts.push(`Page said: ${msgStr}`);
  }

  return parts.join(' ');
}

function buildVoiceoverNarrative(obs: AgentObservation): string {
  const action = obs.step;
  const parts: string[] = [];

  const actionMatch = action.match(/^(\w+)\("(.+?)"\)/);
  const verb = actionMatch?.[1] ?? '';
  const target = actionMatch?.[2] ?? '';

  switch (verb) {
    case 'click_text':
      parts.push(`Clicking "${target}".`);
      break;
    case 'click_selector':
      parts.push('Clicking an element on the page.');
      break;
    case 'fill_input':
      parts.push('Filling in a form field.');
      break;
    case 'navigate':
      parts.push(`Navigating to ${target}.`);
      break;
    case 'open_link_text':
      parts.push(`Opening the "${target}" link.`);
      break;
    case 'scroll':
      parts.push('Scrolling down to see more content.');
      break;
    default:
      parts.push(`Performing action: ${action.replace(/[_()]/g, ' ').trim()}.`);
  }

  if (obs.urlChanged)          parts.push(`The page changed to ${obs.url?.replace(/^https?:\/\//, '') ?? 'a new URL'}.`);
  if (obs.modalOpened)         parts.push('A dialog appeared.');
  if (obs.newInputs?.length)   parts.push(`New form fields appeared: ${obs.newInputs.join(', ')}.`);
  if (obs.visibleSignals?.length) parts.push(`New content visible: ${obs.visibleSignals.slice(0, 2).join(', ')}.`);
  if (obs.apiCalls?.length)    parts.push(`The site made ${obs.apiCalls.length} API call${obs.apiCalls.length > 1 ? 's' : ''}.`);
  if (obs.isNoop)              parts.push('No visible change occurred.');

  if (obs.messages?.length) {
    const important = obs.messages.filter((m) => m.type === 'success' || m.type === 'error');
    if (important.length > 0) {
      parts.push(`The page shows: "${important[0].text.slice(0, 80)}".`);
    }
  }

  return parts.join(' ');
}

function detectBlockerFromText(text: string): BlockerType | undefined {
  // Only classify as a blocker when the text is SHORT (< 600 chars) — that
  // means the page is mostly a gate/modal, not a full product page that
  // happens to mention "sign in" in a nav bar or footer.
  const isShort = text.length < 600;

  // auth_required — Privy social login modal (check BEFORE wallet_required)
  if (/login with twitter|login with github|login with tiktok|login with twitch|login with discord/i.test(text)) return 'auth_required';
  if (/log in or sign up|sign up to continue|create an account to continue/i.test(text)) return 'auth_required';
  if (/continue with a wallet/i.test(text))                   return 'auth_required';
  if (/verify your email|email verification required/i.test(text)) return 'auth_required';
  // auth_required — strong signals (always match)
  if (/sign in to continue|log in to continue|please sign in|please log in/i.test(text)) return 'auth_required';
  if (/登入|登錄|請登入|需要登入/.test(text))                   return 'auth_required';
  // auth_required — weak signals (only match on short/gate pages)
  if (isShort && /\bsign in\b|\blog in\b|\blogin\b/i.test(text)) return 'auth_required';

  // wallet_required — English + Traditional Chinese (after auth checks)
  if (/connect wallet to continue|wallet required|wallet not connected|please connect your wallet/i.test(text)) return 'wallet_required';
  // "connect wallet" alone is weak — only flag on short pages
  if (isShort && /connect wallet|please connect/i.test(text))  return 'wallet_required';
  if (/連接錢包|連結錢包|請連接錢包|未連接錢包|錢包未連接/.test(text)) return 'wallet_required';

  // bot_protection — English + Traditional Chinese + common CAPTCHA variants
  if (/just a moment|checking your browser|verify you are human|are you a robot/i.test(text)) return 'bot_protection';
  if (/complete the captcha|solve the challenge|hcaptcha|recaptcha/i.test(text)) return 'bot_protection';
  if (/access denied|forbidden.*cloudflare|blocked by.*protection/i.test(text)) return 'bot_protection';
  if (/正在驗證您的瀏覽器|請稍候.*驗證|驗證碼/.test(text))       return 'bot_protection';
  // rate_limited
  if (/too many requests|rate limit|slow down|try again later/i.test(text)) return 'rate_limited';
  if (/請求過多|操作太頻繁/.test(text))                         return 'rate_limited';
  // coming_soon — English + Traditional Chinese
  if (/coming soon|under construction|under maintenance|scheduled maintenance/i.test(text)) return 'coming_soon';
  if (/即將推出|敬請期待|建設中|即將上線|維護中/.test(text))      return 'coming_soon';
  // route_missing — English + Traditional Chinese
  if (/page not found|\b404\b|this page doesn.?t exist/i.test(text)) return 'route_missing';
  if (/頁面不存在|找不到頁面/.test(text))                       return 'route_missing';
  // geo_blocked
  if (/not available in your region|country not supported|geographic restriction|unavailable in your location/i.test(text)) return 'geo_blocked';
  if (/您所在地區不支援|地區限制/.test(text))                    return 'geo_blocked';
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fill inputs inside a newly opened modal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Proactively find every visible numeric input whose surrounding DOM context
 * mentions "dev buy" (or similar) and set its value to "0".
 * Called at key points in TOKEN_CREATION flows so the default 0.5 BNB is
 * cleared even if the LLM planner never explicitly fills the field.
 */
async function clearDevBuyFields(page: Page): Promise<void> {
  // Only zero out inputs that are DIRECTLY labeled as a "dev buy" field.
  // We intentionally avoid broad ancestor walks that match shared form containers
  // (which caused Token Name, Symbol, etc. to be wiped on bnbshare.fun).
  //
  // An input qualifies iff at least one of the following is true:
  //   1. Its own name/placeholder/aria-label matches the dev-buy pattern.
  //   2. A <label for="id"> pointing to it matches the pattern.
  //   3. It is nested inside a <label> that matches the pattern.
  //   4. Its immediate parent (depth 1) has only ONE input child AND contains
  //      a label-like element (label/span/div with short text) matching the pattern.
  //      We do NOT walk further because at depth 2+ we risk matching shared form
  //      containers that list all field labels including "Dev Buy".

  const DEV_BUY_RE = /dev.?buy|initial.?buy|launch.?buy/i;

  const inputs = await page
    .locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])')
    .all();

  for (const inp of inputs) {
    const vis = await inp.isVisible().catch(() => false);
    if (!vis) continue;

    const isDevBuy = await inp.evaluate((el) => {
      const DEV = /dev.?buy|initial.?buy|launch.?buy/i;
      const input = el as HTMLInputElement;

      // Rule 1: own attributes
      const ownText = `${input.name ?? ''} ${input.placeholder ?? ''} ${input.getAttribute('aria-label') ?? ''}`;
      if (DEV.test(ownText)) return true;

      // Rule 2: <label for="id">
      if (input.id) {
        const lbl = document.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`);
        if (lbl && DEV.test(lbl.textContent ?? '')) return true;
      }

      // Rule 3: input is inside a <label>
      const parentLabel = input.closest('label');
      if (parentLabel && DEV.test(parentLabel.textContent ?? '')) return true;

      // Rule 4: immediate parent wrapper that owns ONLY this one input
      const parent = input.parentElement;
      if (parent) {
        const inputsInParent = parent.querySelectorAll(
          'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select',
        ).length;
        if (inputsInParent === 1) {
          // Safe to read all non-input child text in this wrapper
          const wrapperText = Array.from(parent.children)
            .filter(c => !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SCRIPT'].includes(c.tagName))
            .map(c => (c.textContent ?? '').trim())
            .filter(t => t.length > 0 && t.length < 60)
            .join(' ');
          if (DEV.test(wrapperText)) return true;
        }
      }

      return false;
    }).catch(() => false);

    if (!isDevBuy) continue;

    const current = await inp.inputValue().catch(() => '');
    if (current !== '0') {
      await inp.fill('0', { timeout: 3_000 }).catch(() => {});
      console.log(`[executor] clearDevBuyFields: cleared field (was "${current}") → "0"`);
    }
  }
}

async function fillModalInputs(page: Page): Promise<string[]> {
  const filled: string[] = [];

  const visInputs = await page
    .locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"])')
    .all();

  for (const inp of visInputs) {
    const vis = await inp.isVisible().catch(() => false);
    if (!vis) continue;

    const ph  = (await inp.getAttribute('placeholder') ?? '').toLowerCase();
    const nm  = (await inp.getAttribute('name')        ?? '').toLowerCase();
    const tp  = (await inp.getAttribute('type')        ?? 'text').toLowerCase();
    const lbl = (await inp.evaluate((el) => {
      const id = el.id;
      if (id) { const l = document.querySelector(`label[for="${id}"]`); if (l) return l.textContent ?? ''; }
      const p = el.closest('label'); if (p) return p.textContent ?? '';
      return '';
    }).catch(() => '')).toLowerCase();

    let val: string;
    if (tp === 'email') {
      val = 'test@example.com';
    } else if (
      // Dev buy / initial purchase amount on token launch forms should always be 0.
      // A non-zero dev buy inflates the transaction value and may hit safety limits.
      /dev.?buy|initial.?buy|launch.?buy|buy.?amount|purchase.?amount/i.test(nm + ' ' + ph + ' ' + lbl)
    ) {
      val = '0';
    } else if (tp === 'number' || nm.includes('count') || nm.includes('num') || nm.includes('amount') || ph.includes('amount')) {
      val = '4';
    } else if (
      ph.includes('0x') || nm.includes('wallet') || nm.includes('address') ||
      lbl.includes('address') || ph.includes('address')
    ) {
      val = '0xDeAd000000000000000000000000000000000000';
    } else if (nm.includes('name') || ph.includes('name') || lbl.includes('name')) {
      val = 'TestToken';
    } else if (nm.includes('symbol') || ph.includes('symbol') || lbl.includes('symbol')) {
      val = 'TEST';
    } else {
      val = '0xDeAd000000000000000000000000000000000000';
    }

    await inp.fill(val).catch(() => {});
    filled.push(`${nm || ph || tp}="${val}"`);
    console.log(`[executor] Auto-filled modal input [${nm || ph || tp}] → "${val}"`);
  }

  if (filled.length > 0) {
    await page.waitForTimeout(400);
    const modalBtns = page.locator('dialog button, [role="dialog"] button, dialog [role="button"], [role="dialog"] [role="button"]')
      .filter({ hasText: /開始|確認|提交|繼續|送出|生成|鑽探|挖礦|領取|下一步|submit|start|confirm|generate|mine|begin|create|launch|continue|next/i });
    const count = await modalBtns.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const modalBtn = modalBtns.nth(i);
      const btnVis  = await modalBtn.isVisible({ timeout: 2_000 }).catch(() => false);
      if (!btnVis) continue;
      const disabled = await modalBtn.isDisabled().catch(() => false);
      if (disabled) continue;
      const btnText = (await modalBtn.textContent().catch(() => '')) ?? '';
      if (isSafeToInteract(btnText)) {
        await modalBtn.click().catch(() => {});
        await page.waitForTimeout(2_000);
        console.log(`[executor] Clicked modal submit: "${btnText.trim()}"`);
        break;
      }
    }
  }

  return filled;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wallet placeholder — planner may emit this token for 0x recipient fields
// ─────────────────────────────────────────────────────────────────────────────

function substituteInvestigationWallet(step: AgentStep, addr?: string): AgentStep {
  if (!addr || step.action !== 'fill_input') return step;
  const v = step.value;
  if (typeof v !== 'string' || !v.includes(INVESTIGATION_WALLET_FILL_TOKEN)) return step;
  return { ...step, value: v.split(INVESTIGATION_WALLET_FILL_TOKEN).join(addr) };
}

function substituteSocialHandle(step: AgentStep, handle: string): AgentStep {
  if (!handle || step.action !== 'fill_input') return step;
  const v = step.value;
  if (typeof v !== 'string' || !v.includes(SOCIAL_HANDLE_FILL_TOKEN)) return step;
  return { ...step, value: v.split(SOCIAL_HANDLE_FILL_TOKEN).join(handle) };
}

const DEV_BUY_PATTERN = /dev.?buy|initial.?buy|launch.?buy|buy.?amount|purchase.?amount/i;

/** Force dev buy / initial purchase fields to "0" based on the selector text. */
function substituteDevBuyToZero(step: AgentStep): AgentStep {
  if (step.action !== 'fill_input') return step;
  const selector = (step.selector ?? '').toLowerCase();
  const value    = (typeof step.value === 'string' ? step.value : '').toLowerCase();

  // Match dev buy labels in the selector
  if (DEV_BUY_PATTERN.test(selector) || DEV_BUY_PATTERN.test(value)) {
    console.log(`[executor] Dev buy override: selector="${step.selector}" value="${step.value}" → "0"`);
    return { ...step, value: '0' };
  }

  // A field with a purely decimal placeholder (e.g. "0.00", "0.000", "0.0000") is
  // almost certainly a BNB amount field in token creation forms. Filling it with
  // a non-zero value inflates the transaction value above the signer's safety limit.
  const placeholderMatch = (step.selector ?? '').match(/placeholder=['"]([^'"]+)['"]/i);
  const placeholder = placeholderMatch?.[1] ?? '';
  if (/^0+\.0+$/.test(placeholder.trim())) {
    const numericValue = parseFloat(typeof step.value === 'string' ? step.value : '0');
    if (!isNaN(numericValue) && numericValue !== 0) {
      console.log(`[executor] Decimal-placeholder field detected (placeholder="${placeholder}") — zeroing value "${step.value}" → "0"`);
      return { ...step, value: '0' };
    }
  }

  return step;
}

/** Applies wallet token + dev-buy zero substitutions for fill_input steps.
 *  Social handle substitution removed — the ReAct LLM now reads field constraints
 *  and chooses values dynamically instead of using a hardcoded handle. */
function applyFillInputSubstitutions(step: AgentStep, opts?: { investigationWalletAddress?: string }): AgentStep {
  let s = substituteInvestigationWallet(step, opts?.investigationWalletAddress);
  // Still substitute SOCIAL_HANDLE_FILL_TOKEN for planned steps emitted by the planner
  // that explicitly use the token — this covers legacy planner steps if any exist.
  s = substituteSocialHandle(s, 'testhandle');
  s = substituteDevBuyToZero(s);
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// executeSteps
//
// ─────────────────────────────────────────────────────────────────────────────
// waitForPageStable — polls until loading indicators clear or maxMs elapses.
//
// Human testers naturally pause when they see a spinner; the agent should too.
// Covers: aria-busy, role=progressbar/status, SVG/CSS spinners, and a broad
// set of in-page text signals including site-specific words like "Analysing…".
// maxMs is raised to 15 s to handle slow async calls (e.g. NFT preview APIs).
// ─────────────────────────────────────────────────────────────────────────────
async function waitForPageStable(page: Page, maxMs = 30_000): Promise<boolean> {
  const POLL_MS = 800;
  const start   = Date.now();
  let triggered = false;

  while (Date.now() - start < maxMs) {
    const isLoading = await page.evaluate(() => {
      // ── ARIA-based loading signals ─────────────────────────────────────────
      if (document.querySelector('[aria-busy="true"], [role="progressbar"]')) return true;

      // role="status" is often used for toast messages too — only count it if
      // the element is non-empty and doesn't look like a success toast.
      const statusEl = document.querySelector('[role="status"]');
      if (statusEl) {
        const t = (statusEl as HTMLElement).innerText?.toLowerCase() ?? '';
        if (t.length > 0 && !/success|done|complete|created|verified/i.test(t)) return true;
      }

      // ── SVG / CSS spinner elements ─────────────────────────────────────────
      // Match class substrings that are reliably spinner-only (not e.g. "overloading")
      const spinnerEl = document.querySelector(
        '[class*="spinner"], [class*="-spin"], [class*="_spin"],' +
        '[class*="skeleton"], [class*="shimmer"],' +
        'svg.animate-spin, [class*="animate-spin"],' +
        '[data-loading="true"], [data-pending="true"]',
      );
      if (spinnerEl) return true;

      // ── Visible text signals ──────────────────────────────────────────────
      // Broad pattern that covers standard English AND site-specific variants
      // like "Analysing…" (Ensoul), "Fetching…", "Minting…", "Submitting…".
      const text = (document.body?.innerText ?? '').toLowerCase();
      const LOADING_RE = new RegExp(
        '\\bloading\\b|\\bprocessing\\b|\\bplease wait\\b|' +
        '\\banalysi[sz]ing\\b|\\bfetching\\b|\\bsubmitting\\b|' +
        '\\bminting\\b|\\bdeploying\\b|\\bsigning\\b|\\bconfirming\\b|' +
        '\\bpreparing\\b|\\bcalculating\\b|\\bverifying\\b',
      );
      // Avoid false-positive on the wallet gate page before the wallet connects
      const onlyWalletGate = /connect wallet/i.test(text) && text.length < 200;
      return LOADING_RE.test(text) && !onlyWalletGate;
    }).catch(() => false);

    if (!isLoading) return triggered;
    triggered = true;  // at least one poll saw a loading state
    await page.waitForTimeout(POLL_MS);
  }
  return triggered;
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentStepExecutor
//
// Encapsulates the OpenAI client singleton and the adaptive step decision
// method. The module-level executeSteps function calls the static methods
// directly — no instance needed.
// ─────────────────────────────────────────────────────────────────────────────

class AgentStepExecutor {
  private static client: OpenAI | null = null;

  static getAdaptiveClient(): OpenAI {
    if (AgentStepExecutor.client) return AgentStepExecutor.client;
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
    AgentStepExecutor.client = new OpenAI({ apiKey: key });
    return AgentStepExecutor.client;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// decideAdaptiveStep
//
// Lightweight LLM call (gpt-4o-mini) that, given the current page state and
// what was already done, returns the single best next AgentStep or null.
//
// Called only at key decision points (max 3 times per feature run):
//   • Loading resolved but no auto-CTA detected (handles non-standard button text)
//   • Plan queue exhausted but budget remains (continues multi-step flows)
//   • Before noop-threshold kills execution (alternative approach attempt)
//
// Design choices:
//   • gpt-4o-mini: 33× cheaper than gpt-4o; more than adequate for "which button
//     to click next" — no deep reasoning needed, just page observation.
//   • 150 max_tokens: exactly enough for one JSON step.
//   • Compact prompt (~200 input tokens): keeps latency ~400 ms, cost ~$0.0001.
// ─────────────────────────────────────────────────────────────────────────────

async function decideAdaptiveStep(
  page:               Page,
  claim:              string,
  passCondition:      string,
  runningNarratives:  string[],
  walletAddress?:     string,
  featureType?:       string,
  structuredState?:   StructuredPageState,
  memory?:            AgentMemory,
  platformDomain?:    string,
  runSuffix?:         string,
): Promise<AgentStep | null> {
  // Capture screenshot in parallel with structured state (if not already provided)
  const [screenshotBuf, pageState] = await Promise.all([
    page.screenshot({ type: 'jpeg', quality: 80, fullPage: false }).catch(() => null as Buffer | null),
    structuredState ?? extractStructuredState(page),
  ]);

  const stateStr = formatStateForLLM(pageState);
  const memoryStr = memory ? formatMemoryForLLM(memory) : '';

  // Check for duplicate action prevention
  const duplicateWarning = memory && memory.actionsPerformed.length > 0
    ? '\nIMPORTANT: Check your memory — do NOT repeat any action you already performed.'
    : '';

  const SYSTEM = `You are a QA tester verifying a web3 feature claim. You see the page through a screenshot AND structured data about every form field, button, error, and toast message.

HOW TO THINK (not what to do):
1. Read the STRUCTURED STATE — it tells you exactly what's on the page: which fields are filled, which are empty, what errors exist, which buttons are enabled.
2. Read your MEMORY — it tells you what you already tried, what failed, and what phase you're in.
3. Decide the ONE action that makes the most progress toward the objective.

DECISION FRAMEWORK:
- If there are EMPTY form fields → fill the first empty one (top to bottom)
- If ALL fields are filled and a submit button is ENABLED → click it
- If there's an ERROR message → read it, understand the cause, fix it (change a value, try a different input)
- If you see a SUCCESS message or transaction confirmation → return null (done)
- If the page is LOADING or transitioning → return {"action":"wait","ms":2000} ONCE, then proceed with a real action on the next step regardless
- If you need to navigate → use navigate action
- If the pass condition mentions specific URL paths (e.g. "/autonomous-economy", "/agentic_bot") AND you're NOT on that page → navigate there FIRST
- If you're on the homepage without relevant content and the pass condition names a path → navigate to that path immediately
- If there are NO form fields visible and this is a TOKEN_CREATION claim → immediately look for and CLICK the "Create", "New", "Mint", or "Build" button. Never scroll first on TOKEN_CREATION.

WALLET_FLOW CLAIMS (platform interaction requiring wallet):
- Your goal is to verify the FEATURE EXISTS and is accessible with a connected wallet — you do NOT need to own specific tokens
- Step 1: Connect wallet if prompted ("Connect Wallet" button) — the investigation wallet auto-connects
- Step 2: After connecting, look for the claimed feature UI (form, button, interface)
- Step 3: If the feature interface is visible (even if partially) → that IS evidence the feature exists
- Step 4: If you see a Telegram bot link or external link as the entry point → that IS evidence (the feature exists via that link)
- Step 5: If the form/CTA is present → try to interact with it. If you need to own tokens first → note it and return null (untestable via test wallet)
- DO NOT assume wallet-gated means the feature doesn't work. Connect first, THEN assess.

TOKEN_CREATION / MINTING CLAIMS — MANDATORY PROTOCOL:
- You MUST attempt to SUBMIT the creation transaction. Filling a form proves nothing.
- Step 1: If on homepage/dashboard and you see a "Create", "Mint", "Build", "New Agent" button → CLICK IT immediately. Do NOT scroll. Do NOT wait. Do NOT read the page first. CLICK THE BUTTON.
  • If wallet connection is required first → click "Connect Wallet", then click the Create button
- Step 2: Fill ALL visible form fields top-to-bottom (use FORM VALUE GUIDELINES below)
- Step 3: Once ALL fields are filled, FIND and CLICK the final submit button (it may say "Create Agent", "Deploy", "Mint", "Build", "Launch", "Confirm", "Submit", "Create")
  • If the submit button is DISABLED after filling all fields → check for validation errors, fix them, then click
  • If it is STILL disabled with no error → try clicking it anyway (some UIs enable on-click)
  • Do NOT skip the submit click — a form filled but not submitted proves NOTHING
- Step 4: After clicking submit, the wallet auto-signs silently (no popup needed).
  • Wait ONE time ({"action":"wait","ms":2000}) THEN immediately look for: success toast, transaction hash, confirmation text, or a redirect to a new page
  • If any of those appear → return null (done, feature confirmed)
  • If the PAGE URL CHANGED after the submit click → return null (likely redirected to confirmation page — feature confirmed)
  • If NOTHING visible changed after one wait → return null anyway (wallet signed in background — transaction was submitted)
  • NEVER wait more than once after a submit. NEVER keep scrolling after submitting.
- NEVER return null between steps 2 and 3 — you MUST click the submit button

FOR DATA/DASHBOARD/LEADERBOARD CLAIMS (no forms to fill):
- Your goal is to OBSERVE and GATHER EVIDENCE, not interact with forms
- CRITICAL: NEVER click "Sign In", "Login", "Login to Claim", "Connect Wallet", "Connect", or ANY auth/wallet-gating button.
  These buttons trigger authentication walls that CRASH the session and destroy all evidence.
  Public leaderboard/stats data is visible WITHOUT logging in — ignore those buttons completely.
  Click ONLY: tab filters ("All", "Top", "24h"), sort headers, pagination arrows, "Load more"
- Scroll down to reveal table rows, charts, or data sections (scroll 400-600px at a time)
- Look for table headers, column names, row data, statistics, numbers
- If you see a table/chart/data section → scroll to reveal more rows, then return null (done)
- Click tab/filter buttons if they reveal more data (e.g. "All", "Top", "Active")
- Do NOT return null immediately just because there are no forms — scroll first to find data
- Do NOT click into individual item detail pages for aggregate stats claims — stay on the dashboard/list view
- SCROLL LIMIT RULE: If your memory shows you have already scrolled 3 or more times on the SAME page
  and still found NO live data (no numbers, no table rows, no agent/token counts) → STOP scrolling.
  Instead, IMMEDIATELY navigate to an alternative statistics page:
  0. Try / (homepage) first — it almost always has live aggregate counters
  1. Try /leaderboard
  2. Then /stats
  3. Then /dashboard
  4. Then /competition or /rankings
  This is critical — endless scrolling on a marketing page wastes budget and finds nothing.
- If the current page is a MARKETING LANDING PAGE (only has CTAs like "Create", "Start", "Join" but no actual data)
  → Try navigating to stats/dashboard pages in this order: /, /leaderboard, /stats, /dashboard, /competition
  → If you land on a page with live data (tables, numbers, agent counts) → done
- If you see any LIVE NUMBERS (e.g. "Total Agents: 1,234", "Volume: $500K", "Active: 89") → that IS the evidence, return null

FORM VALUE GUIDELINES — apply ONLY when filling a form input field:
When you need to pick a value for a specific field, reason from these three things:
  1. PLATFORM — what does the current URL tell you about this platform?
     (e.g. ensoul.io = identity/soul NFTs, bnbshare.fun = token launchpad, bort.fun = AI agent creator)
  2. CLAIM — what specific feature is being verified?
     (e.g. "create a soul profile", "launch an agent", "deploy a token")
  3. FIELD — what does the label + placeholder reveal about expected format and length?

CRITICAL — UNIQUE SUFFIX RULE:
You have been given a unique 4-digit run suffix (see OBJECTIVE block above, "Run suffix: XXXX").
ALWAYS append this exact suffix to every name/handle/title you generate. This prevents conflicts with
names registered in previous test runs. Examples: "qagent7392", "qatoken7392", "qatest7392".

Apply these rules:
- Username / handle fields:
  • SOCIAL-LINKED TOKEN LAUNCHPADS (bnbshare.fun, platforms that require a social handle for fee-sharing):
    ALWAYS use "testuser" — do NOT add the run suffix. This exact handle is required for the on-chain
    vault factory to accept the transaction. If "testuser" is rejected as "already taken",
    try in order: "larpscanbnb", "testuser2", "testuser3", "lscantest01", "verifybot01".
  • All other username/handle fields: use the run suffix — e.g. "qa" + platform-type-word + suffix
    - Identity platform (soul, profile, person) → "qatest{suffix}" (≤15 chars, letters+numbers only)
    - Agent/bot platform → "qagent{suffix}" style
    - ALWAYS ≤15 chars total, letters and numbers only, no spaces, no special chars
    - If rejected ("already taken") → append 2 more random digits
- Name / title / token name fields: MUST include the run suffix — e.g. "QAgent{suffix}"
  • Do NOT use generic static names ("TestAgent", "TestToken", "qaagent01") — these are already taken
  • Identity platform → "QProfile{suffix}", agent platform → "QAgent{suffix}", token launchpad → "QToken{suffix}"
- Description / bio / about fields: one realistic sentence relevant to context
  • e.g. "Automated QA verification agent for performance testing"
- URL fields: match the expected format EXACTLY from the placeholder
  • If placeholder contains "ipfs" → "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"
  • If placeholder shows GitHub → "https://github.com/test/repo"
  • Otherwise → "https://example.com/test"
  • NEVER use "docs.example.com" — it fails most URL validators
- Numeric fields: ALWAYS "0" for any field with a decimal placeholder like "0.00", "0.000", or "0.0000"
  (these are BNB/token amount fields — filling them non-zero inflates the transaction value above safe limits).
  For other numeric fields: use "1" unless the label says "dev buy", "initial buy", or "initial purchase" → "0"
- Email fields: "qa@test.example.com"
- NEVER reuse a value that already produced a validation error — check your step history first
${duplicateWarning}

SAFETY:
- NEVER click "Sign", "Approve", MetaMask, or WalletConnect buttons
- You ARE allowed to click "Connect Wallet" / "Connect your wallet" if it blocks progress
- After clicking "Connect Wallet" and the wallet connects (your address appears on screen),
  IMMEDIATELY look for and click the primary submit/create button (e.g. "Create Token",
  "Launch Token", "Deploy", "Create", "Submit"). Do NOT scroll or navigate away — the
  transaction button is now enabled and must be clicked to complete the verification.
- NEVER submit a form with empty required fields

Return ONE action as JSON, or null if done/stuck:
  {"action":"click_text","text":"<exact button label>"}
  {"action":"fill_input","selector":"<css selector>","value":"<value>"}
  {"action":"scroll","direction":"down","amount":400}
  {"action":"navigate","path":"/<path>"}
  {"action":"wait","ms":2000}  -- use ONLY for ONE pause after a click triggers visible loading. NEVER use wait twice in a row. If page still seems loading after one wait, proceed with a real action anyway.
  null  -- use ONLY when verification is complete or you are truly stuck
`;

  // Extract URL paths from pass condition so the agent has explicit navigation targets
  const passConditionUrlPaths = (passCondition.match(/\/[a-z0-9][a-z0-9_/-]*/gi) ?? [])
    .filter((p) => p !== '/' && p.length > 1 && p.length < 80);
  const passConditionPathsNote = passConditionUrlPaths.length > 0
    ? `\n── PASS-CONDITION NAVIGATION TARGETS ──\nNavigate to these paths to find evidence:\n${passConditionUrlPaths.map((p) => `  navigate("${p}")`).join('\n')}`
    : '';

  const textContext = [
    `OBJECTIVE: Verify claim "${claim}"`,
    `Pass condition: ${passCondition}`,
    runSuffix ? `Run suffix: ${runSuffix} — use this in ALL generated names/handles/tokens` : '',
    walletAddress ? `Wallet: ${walletAddress.slice(0, 10)}… (connected)` : 'Wallet: not connected',
    platformDomain ? `Platform: ${(() => { try { return new URL(platformDomain).hostname; } catch { return platformDomain; } })()}` : '',
    passConditionPathsNote,
    '',
    '── STRUCTURED PAGE STATE ──',
    stateStr,
    '',
    memoryStr ? '── AGENT MEMORY ──\n' + memoryStr : '',
    '',
    '── STEP HISTORY (last 5) ──',
    runningNarratives.slice(-5).map((n, i) => `  ${i + 1}. ${n}`).join('\n') || '  (nothing yet)',
  ].filter(Boolean).join('\n');

  type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail: 'high' } };

  const userContent: ContentPart[] | string = screenshotBuf
    ? [
        { type: 'text', text: textContext },
        {
          type: 'image_url',
          image_url: {
            url:    `data:image/jpeg;base64,${screenshotBuf.toString('base64')}`,
            detail: 'high',
          },
        },
      ]
    : textContext;

  try {
    const resp = await AgentStepExecutor.getAdaptiveClient().chat.completions.create({
      model:       'gpt-4.1',
      temperature: 0,
      max_tokens:  300,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: userContent as string },
      ],
    });

    const raw = (resp.choices[0]?.message?.content ?? '').trim();
    if (!raw || raw === 'null') return null;

    const parsed = JSON.parse(raw) as AgentStep;
    const actionStr = String(parsed.action ?? '');
    if (!parsed?.action || actionStr === 'null' || actionStr === 'none' || actionStr === 'done') return null;

    // Duplicate action prevention using memory
    if (memory && parsed.action === 'fill_input') {
      const step = parsed as { action: 'fill_input'; selector: string; value: string };
      const dup = findDuplicateAction(memory, step.action, step.selector, step.value);
      if (dup) {
        console.log(`[executor] Blocked duplicate fill_input: ${step.selector} = "${step.value}" (already tried, result: ${dup.result})`);
        return null;
      }
    }

    return parsed;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// maybeReviseRemainingSteps
//
// Visual mid-plan revision: after a significant state change (URL navigation or
// modal open), capture a screenshot and ask GPT-4o-mini whether the remaining
// planned steps are still correct given what the page now looks like.
//
// If the model returns a revised set of steps, the caller replaces the queue.
// If null is returned (steps still valid, or revision failed), the caller
// keeps the existing queue unchanged.
//
// This is a lightweight gpt-4o-mini call (~400ms, <$0.0002) and fires at most
// once per plan execution to keep costs bounded.
// ─────────────────────────────────────────────────────────────────────────────

async function maybeReviseRemainingSteps(
  page:           Page,
  remainingSteps: AgentStep[],
  latestObs:      AgentObservation,
  claim:          string,
  featureType:    string,
): Promise<AgentStep[] | null> {
  if (remainingSteps.length < 2) return null;  // not worth revising 0-1 steps

  let screenshotBuf: Buffer | null = null;
  try {
    screenshotBuf = await page.screenshot({ type: 'jpeg', quality: 50, fullPage: false });
  } catch { return null; }

  if (!screenshotBuf) return null;

  const screenshotDataUrl = `data:image/jpeg;base64,${screenshotBuf.toString('base64')}`;
  const remainingJson = JSON.stringify(remainingSteps, null, 2);

  const SYSTEM = `You are a QA agent reviewing a mid-execution test plan. 
The test was verifying this claim: "${claim}" (feature type: ${featureType}).

After the last step, the page changed significantly (navigation or modal). 
A screenshot of the current page is attached.

The remaining planned steps are below. Your job is to decide if they are STILL CORRECT 
given what you see on screen, or if they need to be revised to match the new page state.

RULES:
- If the remaining steps look correct for this page → return the EXACT same steps unchanged
- If 1-2 steps are wrong (e.g. a button label changed, a modal is now open) → fix only those steps
- If the plan is completely wrong for this page → return a new 3-5 step plan
- NEVER add more than 5 steps total
- Only use actions: navigate, click_text, scroll, fill_input, open_link_text, check_text
- NEVER invent CSS selectors — only use ones visible in the page text or accessibility tree
- Return ONLY a JSON array of steps: [{...}, {...}] — no explanation, no markdown`;

  const userText = `Remaining steps to review:\n${remainingJson}\n\nWhat happened just now: ${latestObs.narrative ?? latestObs.result}\nCurrent URL: ${latestObs.url ?? 'unknown'}`;

  type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail: 'low' } };
  const userContent: ContentPart[] = [
    { type: 'text', text: userText },
    { type: 'image_url', image_url: { url: screenshotDataUrl, detail: 'low' } },
  ];

  try {
    const resp = await AgentStepExecutor.getAdaptiveClient().chat.completions.create({
      model:       'gpt-4.1',
      temperature: 0,
      max_tokens:  500,
      messages: [
        { role: 'system', content: SYSTEM },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: 'user',   content: userContent as any },
      ],
    });

    const raw = (resp.choices[0]?.message?.content ?? '').trim();
    if (!raw) return null;

    // Parse: accept bare array or { steps: [...] }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return null; }

    const arr: AgentStep[] = Array.isArray(parsed)
      ? parsed as AgentStep[]
      : (parsed as { steps?: AgentStep[] }).steps ?? [];

    if (!Array.isArray(arr) || arr.length === 0) return null;

    const valid = arr.filter((s): s is AgentStep => !!s?.action).slice(0, 5);
    if (valid.length === 0) return null;

    console.log(`[executor] Mid-plan visual revision: ${remainingSteps.length} → ${valid.length} step(s)`);
    return valid;
  } catch {
    return null;  // never block on a revision failure
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// detectNewFormFields
//
// After a scroll step reveals new content, scan for form inputs that weren't
// visible before. For each new input, generate a fill_input step using the
// same value logic as fillModalInputs — social/fee-sharing handles get the
// FEE_SHARE token, wallet address fields get the wallet token, etc.
//
// This is how the agent handles below-fold fields (e.g. the Twitter handle
// input on bnbshare.fun) without the planner needing to know about them at
// planning time.
// ─────────────────────────────────────────────────────────────────────────────

async function detectNewFormFields(
  page:            Page,
  inputsBefore:    string[],
  alreadyQueued:   AgentStep[],
  walletAddress?:  string,
  maxSteps        = 4,
): Promise<AgentStep[]> {
  const newSteps: AgentStep[] = [];

  const newInputEls = await page.$$eval(
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea',
    (els, before) =>
      els
        .filter((el) => {
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') return false;
          const rect = (el as HTMLElement).getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const key =
            (el as HTMLInputElement).name ||
            (el as HTMLInputElement).placeholder ||
            (el as HTMLInputElement).type ||
            'input';
          return !before.includes(key.slice(0, 40));
        })
        .map((el) => ({
          placeholder: (el as HTMLInputElement).placeholder ?? '',
          name:        (el as HTMLInputElement).name        ?? '',
          type:        (el as HTMLInputElement).getAttribute('type') ?? 'text',
          selector: el.id
            ? `#${CSS.escape(el.id)}`
            : (el as HTMLInputElement).name
              ? `[name="${CSS.escape((el as HTMLInputElement).name)}"]`
              : (el as HTMLInputElement).placeholder
                ? `[placeholder="${CSS.escape((el as HTMLInputElement).placeholder)}"]`
                : 'input',
          labelText: (() => {
            const id = el.id;
            if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l) return (l.textContent ?? '').toLowerCase(); }
            const p = el.closest('label'); if (p) return (p.textContent ?? '').toLowerCase();
            // Walk up MAX 2 levels, stop if container looks like a form group
            let node: Element | null = (el as HTMLElement).parentElement;
            for (let depth = 0; depth < 2 && node; depth++, node = node.parentElement) {
              const tag = node.tagName;
              if (['FORM', 'BODY', 'HTML', 'MAIN', 'SECTION', 'ARTICLE', 'NAV'].includes(tag)) break;
              if (node.children.length > 5) break;
              const siblingText = Array.from(node.children)
                .filter((c) => !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SCRIPT', 'STYLE'].includes(c.tagName))
                .filter((c) => (c.textContent ?? '').length < 60)
                .map((c) => c.textContent ?? '').join(' ').toLowerCase();
              if (siblingText.trim()) return siblingText;
            }
            return '';
          })(),
        })),
    inputsBefore,
  ).catch(() => [] as { placeholder: string; name: string; type: string; selector: string; labelText: string }[]);

  for (const inp of newInputEls) {
    const alreadyPlanned = alreadyQueued.some(
      (s) => s.action === 'fill_input' && (s as { action: string; selector: string }).selector === inp.selector,
    );
    if (alreadyPlanned) continue;

    const hint = (inp.labelText + ' ' + inp.name + ' ' + inp.placeholder).toLowerCase();

    // Only auto-fill fields with universally-known correct values.
    // Everything else (name, title, description, social handle, URL, email, etc.)
    // is intentionally left un-queued so the ReAct LLM can decide the value
    // based on platform context + claim text.
    let value: string | undefined;

    if (/wallet|address|recipient|0x/i.test(hint)) {
      // Wallet address fields: always use the investigation wallet
      value = walletAddress ? INVESTIGATION_WALLET_FILL_TOKEN : undefined;
    } else if (/dev.?buy|initial.?buy|launch.?buy|buy.?amount|purchase.?amount/i.test(hint)) {
      // Dev-buy / initial-purchase: always 0 to avoid exceeding safety limits
      value = '0';
    }
    // All other fields: skip — let the ReAct LLM decide based on context

    if (value) {
      newSteps.push({ action: 'fill_input', selector: inp.selector, value });
    }
  }

  return newSteps.slice(0, maxSteps);
}

// ─────────────────────────────────────────────────────────────────────────────
// passConditionMet — keyword-based early-stop heuristic.
//
// If ≥65% of the meaningful words from the pass condition appear in the current
// page text, the objective is likely achieved — stop consuming budget.
// ─────────────────────────────────────────────────────────────────────────────

function passConditionMet(passCondition: string, pageText: string): boolean {
  const words = (passCondition.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? [])
    .filter((w) => !['that', 'this', 'with', 'from', 'when', 'will', 'have', 'been', 'they', 'their'].includes(w));
  if (words.length < 2) return false;
  const lower = pageText.toLowerCase();
  const matched = words.filter((w) => lower.includes(w)).length;
  return matched / words.length >= 0.65;
}

// ─────────────────────────────────────────────────────────────────────────────
// detectAutoProgressionSteps
//
// After a loading state resolves, scan for buttons to inject as next steps.
//
// Priority 1 — NEW buttons (appeared during loading): click any of them that
//   aren't wallet/auth. If a button appeared after a Preview click, it's almost
//   certainly the next step in the flow regardless of its label text.
//
// Priority 2 — Existing buttons: only click if they match a known progression
//   pattern to avoid accidental clicks on unrelated controls.
//
// Design: removing the strict PROGRESSION_BTN_RE requirement for new buttons
// lets the agent handle arbitrary CTA text ("Build Soul", "Create DNA NFT",
// "Continue to mint", etc.) that the regex would otherwise miss.
// ─────────────────────────────────────────────────────────────────────────────

// Progression verbs for existing (non-new) buttons — still needs a signal
const PROGRESSION_BTN_RE =
  /^(mint|deploy|launch|confirm|submit|continue|proceed|next|approve|purchase|buy|stake|claim|swap|send|create|build|generate|start)\b/i;

// Buttons that should never be auto-clicked regardless of newness
const SKIP_BTN_RE =
  /connect wallet|connect your wallet|sign in|log in|\blogin\b|metamask|walletconnect|rainbow|coinbase|continue with wallet|enable fee|get started|share|report|copy|cancel|close|dismiss/i;

async function detectAutoProgressionSteps(
  page:          Page,
  btnsBefore:    string[],
  alreadyQueued: AgentStep[],
): Promise<AgentStep[]> {
  const btnsNow = await page.$$eval(
    'button:not([disabled]), [role="button"]:not([aria-disabled="true"])',
    (els) => els
      .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100))
      .filter(Boolean),
  ).catch(() => [] as string[]);

  const isAlreadyQueued = (btn: string) =>
    alreadyQueued.some(
      (s) => s.action === 'click_text' && (s as { action: string; text: string }).text === btn,
    );

  const newButtons:      AgentStep[] = [];
  const existingButtons: AgentStep[] = [];

  for (const btn of btnsNow) {
    if (SKIP_BTN_RE.test(btn))  continue;  // never auto-click wallet/auth/close
    if (isAlreadyQueued(btn))   continue;  // already planned

    const isNew = !btnsBefore.includes(btn);
    if (isNew) {
      // Any new button after loading is almost certainly the next step — inject it
      newButtons.push({ action: 'click_text', text: btn });
    } else if (PROGRESSION_BTN_RE.test(btn)) {
      // Existing button that looks like a progression CTA
      existingButtons.push({ action: 'click_text', text: btn });
    }
  }

  // New buttons take priority; fall back to existing progression buttons
  const candidates = newButtons.length > 0 ? newButtons : existingButtons;
  return candidates.slice(0, 2);  // cap at 2 per loading cycle
}


// ─────────────────────────────────────────────────────────────────────────────
// Runs steps with full state-diff tracking and stopping rules.
// Returns observations and a stop reason.
// ─────────────────────────────────────────────────────────────────────────────

export interface ExecuteResult {
  observations:      AgentObservation[];
  stopReason:        'completed' | 'blocker' | 'noop_threshold' | 'budget';
  consecutiveNoops:  number;
  narrationSegments: NarrationSegment[];
}

const STEP_BUDGET = 12;  // 12 total observations — matches REACT_BUDGET=10 with headroom for planned steps

export async function executeSteps(
  page:          Page,
  steps:         AgentStep[],
  baseDomain:    string,
  runApiBuffer:  string[],   // shared mutable array — caller pushes network events here
  options?: {
    stage?: WorkflowStage;
    hypothesis?: WorkflowHypothesis;
    /** Replaces __CV_INVESTIGATION_WALLET__ in fill_input steps */
    investigationWalletAddress?: string;
    /** Passed to adaptive step decisions and early-stop check */
    claim?: string;
    passCondition?: string;
    /** Feature type — used to enforce stricter completion criteria.
     *  TOKEN_CREATION: passConditionMet alone is never enough; also requires
     *  a fill_input OR a transaction attempt before the agent can stop early. */
    featureType?: string;
    /** Unix ms when CDP recording started — used to timestamp narration segments. */
    recordingStartMs?: number;
  },
): Promise<ExecuteResult> {
  const observations: AgentObservation[] = [];
  const narrationSegments: NarrationSegment[] = [];
  let consecutiveNoops  = 0;
  const NOOP_THRESHOLD  = 5;  // raised from 3 — lazy-load scrolls count as noops and 3 is too aggressive
  const runningNarratives: string[] = [];
  let agentMemory = createMemory(options?.claim ?? 'Verify the claim');
  const stepsToRun: AgentStep[] = [...steps];
  // Unique 4-digit suffix for this run — prevents name/handle conflicts across test runs
  const runSuffix = (Date.now() % 10000).toString().padStart(4, '0');

  // Dismiss cookie/GDPR banners once before the first step.
  // Wrapped in a hard timeout — bnbshare.fun and similar dApps have busy JS threads
  // that cause page.evaluate() to hang indefinitely. 8s is enough for consent dismissal.
  console.log('[executor] dismissConsentBanner start');
  await Promise.race([
    dismissConsentBanner(page),
    new Promise<void>((resolve) => setTimeout(resolve, 4_000)),
  ]).catch(() => {});
  console.log('[executor] dismissConsentBanner done');

  // ── Upfront address-input fill (BEFORE any planned steps) ────────────────
  // Claim 01-style WALLET_FLOW claims often have a BSC/wallet address input
  // already visible on the start URL. If we wait for the LLM plan to run
  // those fills, a preceding click_text step (e.g. FAQ accordion) triggers
  // hasInteracted → passConditionMet fires → agent stops before the fill ever
  // runs. By prepending fill + action steps here we guarantee the address is
  // entered as the very first actions, before any planned navigation or clicks.
  if (options?.investigationWalletAddress && options?.featureType !== 'TOKEN_CREATION') {
    // Wrapped in a hard 10s timeout — page.$$eval() can hang on busy-JS dApp pages.
    const upfrontAddrInputs = await Promise.race([
      page.$$eval(
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled])',
        (els) => els
          .filter((el) => {
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden') return false;
            const r = (el as HTMLElement).getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            const hint = [
              (el as HTMLInputElement).placeholder ?? '',
              (el as HTMLInputElement).name ?? '',
              el.id ?? '',
            ].join(' ').toLowerCase();
            return /address|wallet|recipient|bsc|0x|reward/i.test(hint);
          })
          .map((el) => ({
            selector: el.id
              ? `#${CSS.escape(el.id)}`
              : (el as HTMLInputElement).placeholder
                ? `[placeholder="${CSS.escape((el as HTMLInputElement).placeholder)}"]`
              : (el as HTMLInputElement).name
                ? `[name="${CSS.escape((el as HTMLInputElement).name)}"]`
                : 'input',
          currentValue: (el as HTMLInputElement).value ?? '',
        })),
      ),
      new Promise<{ selector: string; currentValue: string }[]>((resolve) => setTimeout(() => resolve([]), 6_000)),
    ]).catch(() => [] as { selector: string; currentValue: string }[]);

    const unfilledUpfront = upfrontAddrInputs.filter((i) => !i.currentValue.trim());
    if (unfilledUpfront.length > 0) {
      console.log(`[executor] Upfront address-fill: ${unfilledUpfront.length} unfilled input(s) — prepending before plan`);
      const prefillSteps: AgentStep[] = unfilledUpfront.map((inp) => ({
        action: 'fill_input' as const,
        selector: inp.selector,
        value: options.investigationWalletAddress!,
      }));
      // Scan for an action button (Start Mining, Claim, Stake, etc.) to inject
      // after the fill so the flow completes in one pass.
      const actionBtn = await Promise.race([
        page.$$eval(
          'button:not([disabled]), [role="button"]:not([aria-disabled="true"]), input[type="submit"]:not([disabled])',
          (els, kw) => {
            const vis = els.filter((el) => {
              const s = window.getComputedStyle(el);
              if (s.display === 'none' || s.visibility === 'hidden') return false;
              const r = (el as HTMLElement).getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            });
            const scored = vis.map((el) => {
              const txt = (el.textContent ?? '').trim().toLowerCase();
              const matchIdx = kw.findIndex((k) => txt.includes(k));
              return { text: (el.textContent ?? '').trim(), score: matchIdx === -1 ? 999 : matchIdx };
            });
            const best = scored.filter((b) => b.score < 999).sort((a, b) => a.score - b.score)[0];
            return best ? best.text : null;
          },
          ['start mining', 'mine', 'claim', 'stake', 'swap', 'send', 'submit', 'start'],
        ),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4_000)),
      ]).catch(() => null as string | null);

      if (actionBtn) {
        prefillSteps.push({ action: 'click_text' as const, text: actionBtn });
      }
      // Prepend so fill runs before any LLM-planned step
      stepsToRun.unshift(...prefillSteps);
    }
  }

  // ── Phase 1: Execute initial planned steps (navigation to surface) ──────
  for (const plannedStep of [...stepsToRun]) {
    if (observations.length >= STEP_BUDGET) break;
    const effectiveStep = applyFillInputSubstitutions(plannedStep, options);
    console.log('[executor] Executing planned step:', effectiveStep);
    const urlBefore = page.url();
    let pStepOk = false;
    try { await performStep(page, effectiveStep, baseDomain, options?.investigationWalletAddress, options?.featureType); pStepOk = true; } catch (e) { console.error('[executor] Planned step error:', e); }
    if (pStepOk && (effectiveStep.action === 'click_text' || effectiveStep.action === 'click_selector')) { await page.waitForTimeout(1_500); await waitForPageStable(page); } else if (pStepOk) { await page.waitForTimeout(1_000); }
    const pUrlAfter = page.url(); const pUrlChanged = pUrlAfter !== urlBefore;
    const pMsgs = await capturePageMessages(page); const pText = await capturePageText(page);
    const pObs: AgentObservation = { step: stepLabel(effectiveStep), isNoop: !pStepOk, result: pStepOk ? 'ok' : 'error', stage: options?.stage ?? 'execution', url: pUrlAfter, urlChanged: pUrlChanged, messages: pMsgs.length ? pMsgs : undefined, pageText: pText.slice(0, 400) };
    pObs.narrative = buildStepNarrative(pObs); runningNarratives.push(pObs.narrative ?? '');
    if (pObs.narrative && options?.recordingStartMs) { narrationSegments.push({ text: buildVoiceoverNarrative(pObs), timestampMs: Math.max(0, Date.now() - options.recordingStartMs) }); }
    observations.push(pObs);
    agentMemory = updateMemory(agentMemory, { action: effectiveStep.action, target: 'selector' in effectiveStep ? (effectiveStep as { selector: string }).selector : ('text' in effectiveStep ? (effectiveStep as { text: string }).text : undefined), value: 'value' in effectiveStep ? (effectiveStep as { value: string }).value : undefined, success: pStepOk, noop: !pStepOk, urlChanged: pUrlChanged, newUrl: pUrlChanged ? pUrlAfter : undefined, pageMessages: pMsgs.map((m) => ({ type: m.type, text: m.text })), visibleErrors: pMsgs.filter((m) => m.type === 'error').map((m) => m.text) });
    let pBlocker = detectBlockerFromText(pText);
    if (pBlocker === 'wallet_required' && options?.investigationWalletAddress) { const reconnected = await autoReconnectWallet(page, options.investigationWalletAddress); if (reconnected) pBlocker = undefined; }
    if ((pBlocker === 'auth_required' || pBlocker === 'bot_protection') && (await getVisibleInputLabels(page)).length === 0) { return { observations, stopReason: 'blocker', consecutiveNoops, narrationSegments }; }
  }

  // ── Phase 2: Pure ReAct loop (observe → decide → act) ──────────────────
  console.log('[executor] Entering ReAct loop');
  let reactStepCount = 0;
  // 10 LLM steps × ~25s each = ~250s max per claim — sufficient for BSC tx flows
  const REACT_BUDGET = 10;
  const visitedRoutes = new Set<string>();  // tracks navigated paths for recovery logic
  let consecutiveScrolls = 0;   // for DATA_DASHBOARD: cap scrolling before trying other pages
  const MAX_DASHBOARD_SCROLLS = 3;  // after 3 scrolls on same page, treat further scrolls as noops
  let consecutiveWaits = 0;
  const MAX_CONSECUTIVE_WAITS = 2; // after 2 waits in a row, force a real action
  while (reactStepCount < REACT_BUDGET && observations.length < STEP_BUDGET) {
    // extractStructuredState uses page.evaluate() which can hang on pages with busy JS
    // threads (live price polling). Wrap in a 10s timeout.
    const pageState = await Promise.race([
      extractStructuredState(page),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
    ]).catch(() => undefined);
    console.log(`[executor] ReAct step ${reactStepCount + 1}/${REACT_BUDGET}`);
    const action = await decideAdaptiveStep(page, options?.claim ?? '', options?.passCondition ?? '', runningNarratives, options?.investigationWalletAddress, options?.featureType, pageState, agentMemory, baseDomain, runSuffix).catch(() => null);
    if (!action) { console.log('[executor] ReAct: LLM returned null — done or stuck'); break; }
    // Handle wait action: pause — but cap consecutive waits to prevent infinite loop
    if (action.action === 'wait') {
      consecutiveWaits++;
      if (consecutiveWaits > MAX_CONSECUTIVE_WAITS) {
        // LLM is stuck in wait-loop — break out and continue as if the page loaded
        console.log(`[executor] ReAct: wait loop detected (${consecutiveWaits} consecutive waits) — forcing progress`);
        consecutiveWaits = 0;
        reactStepCount++; // count as a real step to prevent looping forever
        continue;
      }
      const waitMs = ('ms' in action && typeof action.ms === 'number') ? action.ms : 3000;
      console.log(`[executor] ReAct: waiting ${waitMs}ms for page to settle (${consecutiveWaits}/${MAX_CONSECUTIVE_WAITS})`);
      await page.waitForTimeout(waitMs);
      continue; // don't increment reactStepCount for genuine waits
    }
    consecutiveWaits = 0; // reset on any non-wait action
    console.log(`[executor] ReAct action: ${JSON.stringify(action)}`);
    reactStepCount++;
    if (action.action === 'click_text' && !isSafeToInteract((action as { text: string }).text, options?.featureType)) { console.log(`[executor] ReAct: blocked unsafe click`); continue; }
    // Track visited paths for recovery navigation
    if (action.action === 'navigate' && 'path' in action) {
      visitedRoutes.add((action as { path: string }).path);
    }
    const effectiveStep = applyFillInputSubstitutions(action, options);
    const urlBefore = page.url(); const textBefore = await capturePageText(page);
    let stepSucceeded = false; let loadingTriggered = false;
    try { await performStep(page, effectiveStep, baseDomain, options?.investigationWalletAddress, options?.featureType); stepSucceeded = true; } catch (e) { console.error('[executor] ReAct step error:', e); }
    if (stepSucceeded && (effectiveStep.action === 'click_text' || effectiveStep.action === 'click_selector')) { await page.waitForTimeout(1_500); loadingTriggered = await waitForPageStable(page); if (loadingTriggered) { await page.evaluate(() => window.scrollBy({ top: 400, behavior: 'smooth' })).catch(() => {}); await page.waitForTimeout(600); } } else if (stepSucceeded) { await page.waitForTimeout(1_000); }
    const urlAfter = page.url(); const urlChanged = urlAfter !== urlBefore;
    const stepMessages = await capturePageMessages(page); const textAfter = await capturePageText(page);
    const headingsAfter = await getVisibleHeadings(page); const inputsAfter = await getVisibleInputLabels(page);
    // Off-domain guard
    const bHost = (() => { try { return new URL(baseDomain).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    const aHost = (() => { try { return new URL(urlAfter).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    if (bHost && aHost && !aHost.endsWith(bHost) && !bHost.endsWith(aHost) && urlChanged) { await page.goto(baseDomain, { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {}); await page.waitForTimeout(1_000); }
    const pageTextDiff = Math.abs(textAfter.length - textBefore.length);
    // For DATA_DASHBOARD: after MAX_DASHBOARD_SCROLLS consecutive scrolls on the same page, treat further scrolls as noops
    // This forces navigation to alternative pages instead of endless scrolling
    const isDataDashboard = options?.featureType === 'DATA_DASHBOARD' || options?.featureType === 'dashboard+browser';
    if (effectiveStep.action === 'scroll' && !urlChanged) {
      consecutiveScrolls++;
    } else {
      consecutiveScrolls = 0;
    }
    const scrollCapped = isDataDashboard && effectiveStep.action === 'scroll' && consecutiveScrolls > MAX_DASHBOARD_SCROLLS;
    const isIntrinsicProgress = !scrollCapped && stepSucceeded && (effectiveStep.action === 'fill_input' || effectiveStep.action === 'scroll');
    const isNoop = !isIntrinsicProgress && !loadingTriggered && !urlChanged && pageTextDiff < 50 && stepMessages.length === 0;
    if (isNoop) { consecutiveNoops++; console.log(`[executor] ReAct: noop (${consecutiveNoops})`); } else { consecutiveNoops = 0; }
    if (urlChanged) { consecutiveScrolls = 0; }  // reset on navigation
    const visibleSignals = headingsAfter.filter((h) => !runningNarratives.some((n) => n.includes(h)));
    const obs: AgentObservation = { step: stepLabel(effectiveStep), isNoop, result: stepSucceeded ? 'ok' : 'error', stage: 'execution', url: urlAfter, urlChanged, messages: stepMessages.length ? stepMessages : undefined, pageText: textAfter.slice(0, 400), visibleSignals: visibleSignals.length > 0 ? visibleSignals : undefined };
    obs.narrative = buildStepNarrative(obs); runningNarratives.push(obs.narrative ?? '');
    if (obs.narrative && options?.recordingStartMs) { narrationSegments.push({ text: buildVoiceoverNarrative(obs), timestampMs: Math.max(0, Date.now() - options.recordingStartMs) }); }
    observations.push(obs);
    agentMemory = updateMemory(agentMemory, { action: effectiveStep.action, target: 'selector' in effectiveStep ? (effectiveStep as { selector: string }).selector : ('text' in effectiveStep ? (effectiveStep as { text: string }).text : undefined), value: 'value' in effectiveStep ? (effectiveStep as { value: string }).value : undefined, success: stepSucceeded && !isNoop, noop: isNoop, urlChanged, newUrl: urlChanged ? urlAfter : undefined, pageMessages: stepMessages.map((m) => ({ type: m.type, text: m.text })), visibleErrors: stepMessages.filter((m) => m.type === 'error').map((m) => m.text) });
    const msgLog = stepMessages.length ? ` | messages=[${stepMessages.map((m) => `${m.type}:"${m.text.slice(0, 60)}"`).join(', ')}]` : '';
    console.log(`[executor] → urlChanged=${urlChanged} noops=${consecutiveNoops} noop=${isNoop}${msgLog}`);
    // Deterministic auto-exit for TOKEN_CREATION: once the agent successfully clicks a
    // submit/create/deploy button, the wallet auto-signs silently. There is no visible
    // success state the LLM can reliably detect — so we exit here instead of letting
    // the LLM loop forever waiting for a signal that may never appear in the DOM.
    const isSubmitClick = stepSucceeded &&
      (effectiveStep.action === 'click_text' || effectiveStep.action === 'click_selector') &&
      /^(create|launch|deploy|mint|submit|build|publish|confirm|proceed)\b/i.test(
        ('text' in effectiveStep ? (effectiveStep as { text: string }).text : '') +
        ('selector' in effectiveStep ? (effectiveStep as { selector: string }).selector : ''),
      );
    if (isSubmitClick && (options?.featureType === 'TOKEN_CREATION' || options?.featureType === 'WALLET_FLOW') && !isNoop && agentMemory.currentPhase === 'form_submission') {
      console.log('[executor] ReAct: TOKEN_CREATION/WALLET_FLOW submit from form_filling phase — completing loop');
      return { observations, stopReason: 'completed', consecutiveNoops, narrationSegments };
    }
    // Wallet reconnect + blocker check
    let blockerDetected = detectBlockerFromText(textAfter);
    if (blockerDetected === 'wallet_required' && options?.investigationWalletAddress) { const al = options.investigationWalletAddress.toLowerCase(); const pl = textAfter.toLowerCase(); if (pl.includes(al.slice(0, 6)) && pl.includes(al.slice(-4))) { blockerDetected = undefined; } else { if (await autoReconnectWallet(page, options.investigationWalletAddress)) blockerDetected = undefined; } }
    if (blockerDetected === 'auth_required' && inputsAfter.length === 0) { return { observations, stopReason: 'blocker', consecutiveNoops, narrationSegments }; }
    if (blockerDetected === 'bot_protection') { return { observations, stopReason: 'blocker', consecutiveNoops, narrationSegments }; }
    if (consecutiveNoops >= NOOP_THRESHOLD) {
      // Before giving up: try navigating to an unvisited nav link on the current page
      // For DATA_DASHBOARD, also try known stats paths that weren't in nav links
      const bOrigin = (() => { try { return new URL(baseDomain).origin; } catch { return baseDomain; } })();
      const navLinks = await page.$$eval(
        'nav a[href], header a[href], [role="navigation"] a[href]',
        (els) => els
          .map((el) => (el as HTMLAnchorElement).getAttribute('href') ?? '')
          .filter((h) => h.startsWith('/') && h.length > 1 && h.length < 80),
      ).catch(() => [] as string[]);

      // For DATA_DASHBOARD: inject known stats paths as recovery candidates
      const isDashboard = options?.featureType === 'DATA_DASHBOARD' || options?.featureType === 'dashboard+browser';
      const recoveryPool = isDashboard
        ? ['/', ...navLinks, '/leaderboard', '/stats', '/dashboard', '/competition', '/rankings', '/agents', '/economy']
        : navLinks;
      const recoveryPath = recoveryPool.find((p) => !visitedRoutes.has(p));
      if (recoveryPath) {
        console.log(`[executor] ReAct: noop recovery — navigating to unvisited ${isDashboard ? 'stats' : 'nav'} link ${recoveryPath}`);
        visitedRoutes.add(recoveryPath);
        consecutiveNoops = 0;
        await page.goto(`${bOrigin}${recoveryPath}`, { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(1_500);
        continue;
      }
      return { observations, stopReason: 'noop_threshold', consecutiveNoops, narrationSegments };
    }
    if (agentMemory.isComplete) { console.log(`[executor] ReAct: memory says complete — ${agentMemory.completionReason}`); return { observations, stopReason: 'completed', consecutiveNoops, narrationSegments }; }
  }
  if (observations.length >= STEP_BUDGET) { return { observations, stopReason: 'budget', consecutiveNoops, narrationSegments }; }
  return { observations, stopReason: 'completed', consecutiveNoops, narrationSegments };
}


function buildResultMessage(
  step:          AgentStep,
  urlChanged:    boolean,
  modalOpened:   boolean,
  modalFilled:   string[],
  newInputs:     string[],
  signals:       string[],
  apiCalls:      string[],
  isNoop:        boolean,
): string {
  if (isNoop) return 'Click had no observable effect';

  const parts: string[] = [];
  if (urlChanged) parts.push('URL changed');
  if (modalOpened) parts.push(`modal opened${modalFilled.length > 0 ? ` — filled [${modalFilled.join(', ')}]` : ''}`);
  if (newInputs.length > 0) parts.push(`new inputs appeared: ${newInputs.join(', ')}`);
  if (signals.length > 0) parts.push(`new content: ${signals.join(', ')}`);
  if (apiCalls.length > 0) parts.push(`${apiCalls.length} API call(s)`);
  return parts.join(' | ') || 'Action executed';
}

function stepLabel(step: AgentStep): string {
  switch (step.action) {
    case 'click_text':        return `click_text("${step.text}")`;
    case 'click_selector':    return `click_selector("${step.selector}")`;
    case 'fill_input':        return `fill_input("${step.selector}", "${step.value}")`;
    case 'navigate':          return `navigate("${step.path}")`;
    case 'open_link_text':    return `open_link_text("${step.text}")`;
    case 'scroll':            return `scroll(${step.direction}, ${step.amount ?? 600}px)`;
    case 'wait_for_selector': return `wait_for_selector("${step.selector}")`;
    case 'wait_for_text':     return `wait_for_text("${step.text}")`;
    case 'back':              return 'back()';
    case 'check_text':        return `check_text("${step.text}")`;
    case 'wait':              return `wait(${('ms' in step ? step.ms : undefined) ?? 3000}ms)`;
  }
  return 'unknown()';
}

// ─────────────────────────────────────────────────────────────────────────────
// performStep — low-level action dispatch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Finds every `input[type="file"]` on the page that has no file selected yet
 * and injects a fake PNG so image-required forms can proceed to submission.
 */
async function injectFakeImagesIfNeeded(page: Page): Promise<void> {
  const fileInputs = await page.$$('input[type="file"]').catch(() => [] as import('playwright').ElementHandle[]);
  if (!fileInputs.length) return;

  const pngBuffer = generateFakeTokenPng(64);
  const fakeFile  = {
    name:     'token-logo.png',
    mimeType: 'image/png',
    buffer:   pngBuffer,
  };

  for (const handle of fileInputs) {
    try {
      // Only inject if the input doesn't already have a file
      const hasFile = await (handle.evaluate as (fn: (el: HTMLInputElement) => boolean) => Promise<boolean>)(
        (el) => !!(el.files?.length),
      ).catch(() => false);

      if (!hasFile) {
        await handle.setInputFiles(fakeFile);
        console.log('[executor] ✅ Injected fake token PNG into file input');
        // Give React state a moment to update
        await page.waitForTimeout(800);
      }
    } catch (err) {
      console.warn('[executor] ⚠️  Could not inject file input:', err instanceof Error ? err.message.slice(0, 80) : err);
    }
  }
}

function normalizeStepPath(path: unknown): string {
  if (typeof path !== 'string') return '/';
  const trimmed = path.trim();
  if (!trimmed) return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeHrefToUrl(href: unknown, baseDomain: string): string | null {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http')) return trimmed;
  const base = baseDomain.replace(/\/$/, '');
  return `${base}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
}

async function performStep(page: Page, step: AgentStep, baseDomain: string, walletAddress?: string, featureType?: string): Promise<void> {
  switch (step.action) {

    case 'navigate': {
      const base = baseDomain.replace(/\/$/, '');
      const path = normalizeStepPath(step.path);
      await page.goto(`${base}${path}`, { waitUntil: 'load', timeout: 12_000 }).catch(() =>
        page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 10_000 }),
      );
      await page.waitForTimeout(1_500);
      await triggerWalletReconnect(page);
      await dismissConsentBanner(page);
      break;
    }

    case 'open_link_text': {
      const href = await page.evaluate((text: string) => {
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        const match   = anchors.find((el) => (el.textContent ?? '').trim().includes(text));
        return match ? (match as HTMLAnchorElement).getAttribute('href') : null;
      }, step.text);

      const url = normalizeHrefToUrl(href, baseDomain);
      if (url) {
        await page.goto(url, { waitUntil: 'load', timeout: 12_000 }).catch(() => null);
        await page.waitForTimeout(1_500);
        await triggerWalletReconnect(page);
      } else {
        throw new Error(`Link with text "${step.text}" not found`);
      }
      break;
    }

    case 'scroll': {
      const px = step.amount ?? 600;
      const dy = step.direction === 'up' ? -px : px;
      await page.evaluate((delta: number) => window.scrollBy({ top: delta, behavior: 'smooth' }), dy);
      await page.waitForTimeout(800);
      break;
    }

    case 'click_text': {
      if (!isSafeToInteract(step.text, featureType)) {
        throw new Error(`Blocked by safety filter: "${step.text}"`);
      }

      const isWalletConnect = /connect wallet|connect your wallet|連接錢包|連結錢包/i.test(step.text);

      // Before clicking a submit/create button, auto-inject fake images and
      // mark so we wait longer for the async transaction to come back.
      // Matches final-action buttons on token launchers, NFT minters, agent creators, etc.
      const isSubmitAction = /^(create|launch|deploy|mint|submit|build|publish|generate|confirm|proceed|next|continue|create\s+agent|create\s+new\s+agent|build\s+agent|deploy\s+agent|create\s+token|launch\s+token|deploy\s+token|create\s+nft|mint\s+nft|mint\s+soul|mint\s+token)$/i.test(step.text.trim())
        || /^(create|launch|deploy|mint|build|publish)\s+\w+$/i.test(step.text.trim());
      if (isSubmitAction) {
        await injectFakeImagesIfNeeded(page);
        await clearDevBuyFields(page);
      }

      const textRegex = new RegExp(step.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const formBtn = page.locator('form button, form [role="button"], form input[type="submit"]').filter({ hasText: textRegex }).first();
      const btnLoc  = page.locator('button, [role="button"]').filter({ hasText: textRegex }).first();
      const linkLoc = page.locator('a').filter({ hasText: textRegex }).first();
      const textLoc = page.getByText(step.text, { exact: false }).first();

      let locator = formBtn;
      let visible = await formBtn.isVisible({ timeout: 2_000 }).catch(() => false);
      if (!visible) {
        locator = btnLoc;
        visible = await btnLoc.isVisible({ timeout: 2_000 }).catch(() => false);
      }
      if (!visible) {
        visible = await linkLoc.isVisible({ timeout: 2_000 }).catch(() => false);
        if (visible) locator = linkLoc;
      }
      if (!visible) {
        visible = await textLoc.isVisible({ timeout: 2_000 }).catch(() => false);
        if (visible) locator = textLoc;
      }
      if (!visible) throw new Error(`Element not found: "${step.text}"`);

      // Scroll the element into view first, then click
      await locator.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
      try {
        await locator.click({ timeout: 5_000 });
      } catch {
        // Fallback: force click (bypasses element interception)
        await locator.click({ force: true, timeout: 3_000 });
      }

      if (isWalletConnect && walletAddress) {
        console.log('[executor] Wallet connect click detected — firing mock events');
        await page.waitForTimeout(2_000);
        await triggerWalletReconnect(page, { waitMs: 2_000 });
        await tryPickWalletInModal(page);
      }
      // Submit actions (Create Token / Deploy) trigger async on-chain transactions.
      // Poll for the page to show a tx-related signal rather than blindly waiting,
      // so slow BSC RPC conditions (sometimes 15-30s) don't cause a missed hash.
      if (isSubmitAction) {
        const TX_SIGNALS = /transaction|tx hash|submitted|0x[0-9a-f]{20}/i;
        let txFound = false;
        for (let w = 0; w < 20 && !txFound; w++) {       // up to 20 × 1.5s = 30s
          await page.waitForTimeout(1_500);
          const txt = await capturePageText(page).catch(() => '');
          if (TX_SIGNALS.test(txt)) {
            txFound = true;
            console.log('[executor] ✅ TX signal detected after', (w + 1) * 1.5, 's');
          }
        }
        if (!txFound) {
          // Still wait the minimum so the bridge has time to resolve async
          await page.waitForTimeout(3_000);
        }
      } else {
        await page.waitForTimeout(2_000);
      }
      break;
    }

    case 'click_selector': {
      const el      = page.locator(step.selector).first();
      const visible = await el.isVisible({ timeout: 4_000 }).catch(() => false);
      if (!visible) throw new Error(`Selector not found: "${step.selector}"`);

      const text = await el.textContent().catch(() => '') ?? '';
      if (!isSafeToInteract(text, featureType)) throw new Error(`Blocked by safety filter: "${text}"`);

      // Zero out dev buy fields before any submit-like click
      if (/create|launch|deploy|mint|submit/i.test(text)) {
        await clearDevBuyFields(page);
      }

      await el.click({ timeout: 5_000 });
      await page.waitForTimeout(2_000);
      break;
    }

    case 'fill_input': {
      let inputEl = page.locator(step.selector).first();
      let found   = await inputEl.isVisible({ timeout: 3_000 }).catch(() => false);

      if (!found) {
        // Better fallback: semantically match selector tokens against input name,
        // placeholder, aria-label, or associated label text before defaulting to first input.
        const token = step.selector
          .replace(/[.#\[\]="'`]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();

        const matchIndex = await page.$$eval(
          'input:not([type="hidden"]), textarea, select',
          (nodes, tok) => {
            // Use the full DOM index (not a visibility-filtered sub-index) so
            // page.locator().nth(matchIndex) points to the same element.
            const scored = nodes.map((el, domIdx) => {
              const s = window.getComputedStyle(el);
              if (s.display === 'none' || s.visibility === 'hidden') {
                return { domIdx, score: -Infinity };
              }
              const id = (el as HTMLElement).id;
              const lbl = id
                ? (document.querySelector(`label[for="${id}"]`)?.textContent ?? '')
                : ((el.closest('label')?.textContent) ?? '');
              const text = [
                (el as HTMLInputElement).name ?? '',
                (el as HTMLInputElement).placeholder ?? '',
                (el as HTMLElement).getAttribute('aria-label') ?? '',
                lbl,
              ].join(' ').toLowerCase();
              const requiredBoost = (el as HTMLInputElement).required ? 1 : 0;
              const type = ((el as HTMLInputElement).type ?? '').toLowerCase();
              const typeBoost = /text|email|number|search|url/.test(type) ? 1 : 0;
              // Word-level overlap: split tok into meaningful keywords and count
              // how many appear in the input's combined text. This handles
              // hallucinated selectors like "[placeholder="Twitter handle (optional)"]"
              // where "twitter" still matches the Twitter field's label text.
              const words = tok
                .split(' ')
                .filter((w: string) => w.length > 3 && !['placeholder', 'selector', 'input', 'textarea', 'select'].includes(w));
              const wordHits = words.filter((w: string) => text.includes(w)).length;
              const score = (wordHits > 0 ? wordHits + 1 : 0) + requiredBoost + typeBoost;
              return { domIdx, score };
            });

            scored.sort((a, b) => b.score - a.score);
            const best = scored.find((x) => isFinite(x.score));
            return best?.domIdx ?? 0;
          },
          token,
        ).catch(() => 0);

        inputEl = page.locator('input:not([type="hidden"]), textarea, select').nth(matchIndex);
        found = await inputEl.isVisible({ timeout: 1_000 }).catch(() => false);
      }

      if (!found) throw new Error(`Input not found: "${step.selector}"`);

      // Final guard: inspect the actual DOM element to detect dev buy fields.
      // Walk up MAX 2 ancestor levels (immediate parent + grandparent) so we
      // catch div-wrapped labels without accidentally matching the whole form
      // (which would make every field look like a dev-buy field).
      const isDevBuyField = await inputEl.evaluate((el) => {
        const DEV_BUY_RE = /dev.?buy|initial.?buy|launch.?buy|buy.?amount|purchase.?amount/i;

        const name  = ((el as HTMLInputElement).name        ?? '').toLowerCase();
        const ph    = ((el as HTMLInputElement).placeholder ?? '').toLowerCase();
        const aria  = (el.getAttribute('aria-label')        ?? '').toLowerCase();
        const id    = ((el as HTMLElement).id               ?? '').toLowerCase();

        // Try formal label association first
        const labelEl   = el.id
          ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
          : el.closest('label');
        const labelText = (labelEl?.textContent ?? '').toLowerCase();

        if (DEV_BUY_RE.test(`${name} ${ph} ${aria} ${id} ${labelText}`)) return true;

        // Walk up MAX 1 ancestor level (immediate parent only).
        // Stop if the container owns more than one input — it's a shared form
        // section, not a single-field wrapper, and matching there would cause
        // every field in the form to look like a dev-buy field.
        const parent = (el as HTMLElement).parentElement;
        if (parent) {
          const tag = parent.tagName;
          if (!['FORM', 'BODY', 'HTML', 'MAIN', 'SECTION', 'ARTICLE', 'NAV'].includes(tag)) {
            const inputsInParent = parent.querySelectorAll(
              'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select',
            ).length;
            if (inputsInParent === 1) {
              const wrapperText = Array.from(parent.children)
                .filter(c => !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SCRIPT', 'STYLE'].includes(c.tagName))
                .map(c => (c.textContent ?? '').trim())
                .filter(t => t.length > 0 && t.length < 60)
                .join(' ')
                .toLowerCase();
              if (DEV_BUY_RE.test(wrapperText)) return true;
            }
          }
        }

        return false;
      }).catch(() => false);

      const finalFillValue = isDevBuyField ? '0' : step.value;
      if (isDevBuyField && step.value !== '0') {
        console.log(`[executor] DOM dev buy field detected — overriding value "${step.value}" → "0"`);
      }

      await inputEl.fill(finalFillValue, { timeout: 5_000 });
      await page.waitForTimeout(800);
      break;
    }

    case 'wait_for_selector': {
      await page.waitForSelector(step.selector, { timeout: 5_000 });
      break;
    }

    case 'wait_for_text': {
      await page.waitForFunction(
        (text: string) => document.body.innerText.includes(text),
        step.text,
        { timeout: 5_000 },
      );
      break;
    }

    case 'back': {
      await page.goBack({ waitUntil: 'load', timeout: 8_000 }).catch(() => null);
      await page.waitForTimeout(1_500);
      break;
    }

    case 'check_text': {
      const found = await page
        .getByText(step.text, { exact: false })
        .first()
        .isVisible({ timeout: 3_000 })
        .catch(() => false);
      if (!found) throw new Error(`Text not found: "${step.text}"`);
      break;
    }
  }
}


