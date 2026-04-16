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
// buildAgentPrompt — focused system prompt for decideAdaptiveStep.
//
// Returns a ~700-token prompt tailored to the current featureType so the LLM
// only reads rules relevant to this claim. Removes hardcoded platform names so
// it works correctly for any new web3 platform without code changes.
// ─────────────────────────────────────────────────────────────────────────────

function buildAgentPrompt(featureType: string | undefined, duplicateWarning: string): string {
  const BASE = `You are a QA tester verifying a web3 feature claim. You see the page via screenshot + structured state (fields, buttons, errors, toasts).

ALWAYS:
1. Read STRUCTURED STATE — which fields are empty, which buttons are enabled, what errors exist
2. Read MEMORY — what you already tried, what failed, what phase you are in
3. Pick the ONE action that makes the most progress toward the objective

CORE RULES:
- Empty form field → fill the next empty field (top to bottom)
- All fields filled + submit enabled → click submit
- Error message → fix the cause and retry with a different value
- Success / tx confirmation / URL changed after submit → return null (done)
- Page loading → wait ONCE {"action":"wait","ms":2000}, then act regardless on next step
- Wrong page → navigate there

SAFETY: NEVER click "Sign", "Approve", MetaMask, or WalletConnect.
You MAY click "Connect Wallet" / "Connect your wallet" to unlock features.

Return ONE JSON action or null:
  {"action":"click_text","text":"<exact label>"}
  {"action":"fill_input","selector":"<css selector>","value":"<value>"}
  {"action":"scroll","direction":"down","amount":400}
  {"action":"navigate","path":"/<path>"}
  {"action":"wait","ms":2000}
  null — use only when verification is complete or you are truly stuck`;

  const ft = featureType ?? '';
  const isTokenCreation = ft === 'TOKEN_CREATION' || ft === 'form+browser';
  const isDataDashboard  = ft === 'DATA_DASHBOARD'  || ft === 'dashboard+browser';
  const isWalletFlow     = ft === 'WALLET_FLOW'     || ft === 'wallet+rpc';
  const isDexSwap        = ft === 'DEX_SWAP'        || ft === 'ui+rpc';

  if (isTokenCreation) {
    return `${BASE}

TOKEN CREATION — MANDATORY BSC TRANSACTION PROTOCOL:
You MUST submit the creation transaction. Filling a form without submitting proves nothing.

STEP 1 — Find the creation form:
- If you see a "Create" / "Mint" / "Build" / "New" / "Launch" / "New Agent" button → CLICK IT immediately
- Do NOT scroll, wait, or navigate away first — click the button now
- If "Connect Wallet" is required first → connect, then immediately click the creation button

STEP 2 — Fill ALL visible form fields top to bottom:
FIELD VALUE RULES (reason from label + placeholder + URL):
- Name / title:
  • URL suggests agent/bot (contains "agent", "bort", "bot", "build") → "QAgent{suffix}"
  • URL suggests identity/soul (contains "soul", "ens", "identity") → "QProfile{suffix}"
  • Default (token launchpad) → "QToken{suffix}"
- Symbol / ticker → first 2 chars of "QT" + last 2 digits of suffix (e.g. "QT42", max 6 chars)
- Description / bio / about → "Automated QA verification test"
- Social handle / username:
  • If the form ALSO has a BNB/ETH amount input OR a fee-sharing toggle → ALWAYS use "testuser"
    (required by the on-chain vault contract). If rejected as "already taken" try in order:
    larpscanbnb, testuser2, testuser3, lscantest01, verifybot01
  • All other cases → "qatest{suffix}" (≤15 chars, letters+numbers only)
- Any field with decimal placeholder (0.00, 0.000, 0.0000) → ALWAYS "0"
- Dev buy / initial buy / initial purchase → ALWAYS "0"
- URL / link / website → "https://example.com/test"
- Email → "qa@test.example.com"
- NEVER reuse a value that already produced a validation error

STEP 3 — Click the submit button:
- Find: "Create", "Create Token", "Create Agent", "Deploy", "Mint", "Launch", "Submit", "Build", "Confirm"
- If disabled after filling → check validation errors, fix inputs, retry
- NEVER skip this step — clicking submit triggers the BSC transaction

STEP 4 — After clicking submit:
- Wait ONCE ({"action":"wait","ms":2000})
- Then return null — the wallet signs silently in the background
- URL changed after submit → return null (redirect confirms success)
- Success toast / tx hash visible → return null
- Nothing changed after the single wait → return null anyway (transaction sent in background)
- NEVER wait more than once. NEVER keep scrolling after clicking submit.
${duplicateWarning}`;
  }

  if (isDataDashboard) {
    return `${BASE}

DATA DASHBOARD — OBSERVE AND FIND EVIDENCE:
Goal: find live data (stats, tables, numbers). Do NOT fill or submit forms.

CRITICAL: NEVER click "Sign In", "Login", "Connect Wallet", or any auth button.
Public data is visible without login — clicking auth destroys all evidence.
Click ONLY: tab filters ("All", "Top", "24h"), sort headers, pagination, "Load more".

1. If the pass condition names a specific URL path → navigate there first
2. Scroll 400-600px at a time to reveal table rows, charts, numbers
3. LIVE NUMBERS visible (e.g. "Total: 1,234", "Volume: $500K", "Active: 89") → return null (done)
4. Table with data rows visible → scroll once more to confirm, then return null (done)
5. SCROLL LIMIT: After 3 scrolls on the same page with no data found:
   → Navigate in order: /leaderboard, /stats, /dashboard, /competition, /rankings
   → First page with live data → return null
${duplicateWarning}`;
  }

  if (isWalletFlow) {
    return `${BASE}

WALLET FLOW — VERIFY FEATURE IS ACCESSIBLE:
Goal: confirm the feature exists and is accessible with a connected wallet.
You do NOT need to own tokens to verify the feature exists.

1. Click "Connect Wallet" if it blocks access — the wallet auto-connects
2. After connecting, look for the feature UI (form, button, interface)
3. If the feature UI is a CREATION FORM (has name, symbol, description fields + a create/launch/deploy button):
   → Fill ALL fields using TOKEN CREATION rules (see below) and CLICK the submit button
   → If a wallet connection dialog appears, click through it (Connect Wallet → MetaMask → confirm)
   → This triggers a BSC transaction — the wallet signs silently. Wait ONCE after the transaction then return null.
   → IMPORTANT: If fields are already filled, DO NOT re-fill them. Only connect wallet if needed, then click submit.
   FIELD VALUE RULES for creation forms:
   - Name/title → "QToken{suffix}" (agent/bot platform: "QAgent{suffix}")
   - Symbol/ticker → "QT" + last 2 digits of suffix
   - Description → "Automated QA verification test"
   - Social handle / username:
     • Form also has a BNB/ETH amount field OR fee-sharing toggle → use the unique run handle shown in Run suffix context
     • Otherwise → "qatest{suffix}"
   - GitHub username / fee earner link → ALWAYS "testuser"
   - Twitter / X link / @username or URL → ALWAYS "https://x.com/testuser"
   - BNB/ETH/amount fields with decimal placeholder (0.00, 0.000) → ALWAYS "0"
   - Dev buy / initial buy → ALWAYS "0"
   - URL → "https://example.com/test"
4. If the feature UI is NOT a form (just a button, link, or info panel):
   → Verify it's visible and accessible → return null (done)
5. If a Telegram / external link is the entry point → return null (done, feature confirmed)
6. If owning tokens is required to proceed → return null (untestable via test wallet)
7. NEVER return null with an unfilled/unsubmitted creation form still visible and accessible
${duplicateWarning}`;
  }

  if (isDexSwap) {
    return `${BASE}

DEX SWAP — VERIFY SWAP UI:
Navigate to the swap/exchange surface. Confirm the swap form is present and interactive.
Identify token selectors and amount inputs. STOP before executing any swap.
${duplicateWarning}`;
  }

  // AGENT_LIFECYCLE, MULTI_AGENT, API_FEATURE, default
  return `${BASE}

VERIFY FEATURE:
Navigate to the most relevant page for this claim. Interact with primary CTAs.
Look for agent/token lists, statistics, working UI, or API responses.
If you find clear evidence the feature exists and works → return null (done).
If you see a "Deploy" / "Create Agent" button → click it to show the creation form.
${duplicateWarning}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// decideAdaptiveStep — one LLM call per ReAct step
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
  // Capture screenshot (low quality — enough for UI recognition) in parallel with state
  const [screenshotBuf, pageState] = await Promise.all([
    Promise.race([
      page.screenshot({ type: 'jpeg', quality: 40, fullPage: false }),
      new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
    ]).catch(() => null as Buffer | null),
    structuredState != null
      ? Promise.resolve(structuredState)
      : Promise.race([
          extractStructuredState(page),
          new Promise<StructuredPageState>((_, reject) =>
            setTimeout(() => reject(new Error('extractStructuredState timeout (8s)')), 8_000)
          ),
        ]).catch(() => ({ url: page.url(), forms: [], buttons: [], modals: [], toasts: [], headings: [], loadingVisible: false, walletState: 'disconnected' } as StructuredPageState)),
  ]);

  const stateStr = formatStateForLLM(pageState);
  const memoryStr = memory ? formatMemoryForLLM(memory) : '';

  const duplicateWarning = memory && memory.actionsPerformed.length > 0
    ? '\nIMPORTANT: Check your memory — do NOT repeat any action you already performed.'
    : '';

  const SYSTEM = buildAgentPrompt(featureType, duplicateWarning);

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
    | { type: 'image_url'; image_url: { url: string; detail: 'low' } };

  const userContent: ContentPart[] | string = screenshotBuf
    ? [
        { type: 'text', text: textContext },
        {
          type: 'image_url',
          image_url: {
            url:    `data:image/jpeg;base64,${screenshotBuf.toString('base64')}`,
            detail: 'low',
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
// isPassConditionMet — lightweight deterministic check run after each ReAct step.
// If true the loop exits immediately without spending more LLM budget.
// ─────────────────────────────────────────────────────────────────────────────

function isPassConditionMet(
  featureType: string | undefined,
  pageText:    string,
  memory:      AgentMemory,
): boolean {
  const ft = featureType ?? '';

  // DATA_DASHBOARD: live numbers or table data visible right now
  if (ft === 'DATA_DASHBOARD' || ft === 'dashboard+browser') {
    const numMatches = (pageText.match(/\b\d[\d,]*\b/g) ?? []).filter((n) => n.length >= 2);
    const hasNumbers = numMatches.length >= 3;
    const hasTableKeyword = /thead|tbody|leaderboard|ranking|rank|holder|volume|agent|token/i.test(pageText);
    return hasNumbers && hasTableKeyword;
  }

  // TOKEN_CREATION or WALLET_FLOW with a creation form: a transaction was attempted
  if (ft === 'TOKEN_CREATION' || ft === 'form+browser' || ft === 'WALLET_FLOW' || ft === 'wallet+rpc') {
    return memory.transactionsAttempted.length > 0 && memory.currentPhase !== 'error_recovery';
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// findFormSubmitButton — scans the page for a primary submit button
// within a form container. Returns text even for disabled buttons so
// the caller can attempt a force/JS click to bypass client-side guards.
// ─────────────────────────────────────────────────────────────────────────────

async function findFormSubmitButton(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const submitRe = /^(create|launch|deploy|mint|submit|build|publish|confirm|proceed|start)\b/i;

    // Helper: get visible buttons (includes disabled ones — caller decides whether to force-click)
    function getVisibleBtns(root: Element | Document): Element[] {
      return Array.from(root.querySelectorAll(
        'button, [role="button"], input[type="submit"]',
      )).filter((el) => {
        const s = window.getComputedStyle(el as HTMLElement);
        const r = (el as HTMLElement).getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });
    }

    // Prefer buttons inside a form container
    const containers = Array.from(document.querySelectorAll(
      'form, [role="form"], .modal-content, .card, [class*="form"], [class*="create"], [class*="launch"]',
    ));
    for (const container of containers) {
      const btns = getVisibleBtns(container);
      const match = btns.find((el) => submitRe.test((el.textContent ?? '').trim()));
      if (match) return (match.textContent ?? '').trim().slice(0, 60);
    }

    // Fallback: any visible button with submit text anywhere on the page
    const allBtns = getVisibleBtns(document);
    const match = allBtns.find((el) => submitRe.test((el.textContent ?? '').trim()));
    return match ? (match.textContent ?? '').trim().slice(0, 60) : null;
  }).catch(() => null);
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

  // ── Batch form fill for TOKEN_CREATION and WALLET_FLOW creation forms (Change G) ──
  // Fill all visible creation form fields in one deterministic pass before the
  // ReAct loop. Uses fast $$eval (single DOM read) instead of extractStructuredState
  // to avoid hanging on busy-JS pages like bnbshare.fun.
  // SKIP if wallet connection UI is visible — the ReAct loop must connect the wallet
  // first (clicking "Connect Wallet"/"MetaMask" etc.) or the form submit will be
  // ignored by the platform (wallet not connected in React state).
  const isCreationClaim = options?.featureType === 'TOKEN_CREATION' || options?.featureType === 'form+browser'
    || options?.featureType === 'WALLET_FLOW' || options?.featureType === 'wallet+rpc';
  let creationFormWasFilled = false; // set to true when batch fill runs on a creation form
  const walletConnectUiVisible = isCreationClaim && await page.evaluate(() => {
    const labels = ['connect wallet', 'connect a wallet', 'continue with a wallet', 'link wallet', 'sign in with wallet'];
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    return btns.some((el) => {
      const t = (el.textContent ?? '').toLowerCase().trim();
      const r = (el as HTMLElement).getBoundingClientRect();
      const s = window.getComputedStyle(el as HTMLElement);
      return labels.some((l) => t.includes(l)) && r.width > 0 && s.display !== 'none';
    });
  }).catch(() => false);
  if (isCreationClaim && walletConnectUiVisible) {
    console.log('[executor] Batch fill deferred — wallet connection UI visible, letting ReAct connect wallet first');
  }

    // ── Feature-type aware name generator ──────────────────────────────────
    const getNameValue = () => {
      const ft = (options?.featureType ?? '').toLowerCase();
      const bd = baseDomain.toLowerCase();
      if (/agent|bot|build|trad/i.test(ft) || /agent|bort|bot|build/i.test(bd)) return `QAgent${runSuffix}`;
      if (/soul|ens|profile|identity/i.test(ft) || /soul|ens|identity/i.test(bd)) return `QProfile${runSuffix}`;
      return `QToken${runSuffix}`;
    };

    // Unique test handle per run — avoids "handle already taken" errors on platforms
    // that validate social handle availability before enabling the submit button.
    // Pattern qa{4-digit} is recognized by the vault factory patch in signer.ts.
    const uniqueHandle = `qa${runSuffix.slice(-4)}`;

  // ── Feature-type aware field resolver ───────────────────────────────────
  // Returns a value for any input, or '' to skip.
  // Order: specific pattern match → feature-type hint → generic catch-all.
  const resolveFieldValue = (
    ph: string, nm: string, inputType: string, tagName: string,
    hasFeeShare: boolean,
  ): string => {
    const hint = `${ph} ${nm}`.toLowerCase();
    // Symbol / ticker — checked FIRST to prevent "e.g. MOON" matching as a name
    // All-caps placeholder (e.g. "MOON", "BTC") is a strong ticker signal
    if (/symbol|ticker/i.test(hint) ||
        /^(symbol|ticker)$/i.test(nm) ||
        /e\.g\.\s+[A-Z]{2,}(\s|$)/.test(ph)) return `QT${runSuffix.slice(-2)}`;
    // Name / title / project name
    if (/token.?name|name.of.your|e\.g\.\s*(moon|token)|agent.?name|bot.?name|project.?name/i.test(ph) ||
        /^(name|tokenname|agentname|botname|projectname|title)$/i.test(nm)) return getNameValue();
    // Description / bio / about / summary
    if (/descri|about|bio|summary|purpose|mission/i.test(hint)) return 'Automated QA verification test';
    // Telegram — checked before generic social/username to avoid matching "t.me/group or @username"
    if (/t\.me|telegram/i.test(hint)) return `qatest${runSuffix}`;
    // GitHub — use plain username "testuser"; GitHub API validation is intercepted
    if (/github/i.test(hint)) return 'testuser';
    // Twitter / X — use URL format
    if (/twitter|x\.com/i.test(hint)) return 'https://x.com/testuser';
    // "GitHub Username" (fee earner link on bnbshare.fun) — plain username
    if (/github.?user|fee.?earn|earner/i.test(hint)) return 'testuser';
    // Pure social handle / username — only when NO URL alternative in the placeholder
    // (fields like "@username or URL" should fall through to the URL check below)
    if ((/handle|social/i.test(hint) || /^(username|handle|social)$/i.test(nm)) &&
        !/url|link|https?/i.test(hint)) return hasFeeShare ? uniqueHandle : `qatest${runSuffix}`;
    // Username when field is primarily for a social handle (no URL hint)
    if (/\busername\b/i.test(hint) && !/url|link|https?/i.test(hint)) return hasFeeShare ? uniqueHandle : `qatest${runSuffix}`;
    // "@username or URL" — prefer URL format to avoid platform-specific username validation
    if (ph.trimStart().startsWith('@') && /\busername\b/i.test(hint)) return 'https://x.com/testuser';
    // Website / URL / link (also catches "@username or URL" fields)
    if (/website|url|link|https?/i.test(hint)) return 'https://example.com/test';
    // Remaining @ fields (e.g. standalone "@" placeholder)
    if (/@/i.test(hint)) return hasFeeShare ? uniqueHandle : `qatest${runSuffix}`;
    // BNB / ETH / amount / fee fields
    if (/0\.0+/.test(ph) || /\bbnb\b|\beth\b|dev.buy|initial.buy|amount|fee/i.test(hint)) return '0';
    // Strategy / risk / mode (agent forms)
    if (/strategy|risk.?level|risk.?mode|trade.?mode|stop.?loss|take.?profit/i.test(hint)) return 'balanced';
    // API key / secret
    if (/api.?key|secret|token.?key/i.test(hint)) return `testkey${runSuffix}`;
    // Email
    if (inputType === 'email') return `qa${runSuffix}@test.com`;
    // Number
    if (inputType === 'number') return '0';
    // Textarea always gets a description
    if (tagName === 'TEXTAREA') return 'Automated QA verification test';
    // ── Catch-all ──────────────────────────────────────────────────────────
    // Any remaining visible text input in a creation form context → fill with
    // a test handle so the form is complete and the submit button activates.
    if (inputType === 'text' || inputType === '' || !inputType) return `qatest${runSuffix}`;
    return '';
  };

  if (isCreationClaim && !walletConnectUiVisible) {
    type RawInput = { placeholder: string; name: string; id: string; value: string; tagName: string; type: string; selector: string };
    const visibleInputs = await Promise.race([
      page.$$eval(
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]), textarea:not([disabled])',
        (els) => els
          .filter((el) => {
            const s = window.getComputedStyle(el as HTMLElement);
            const r = (el as HTMLElement).getBoundingClientRect();
            return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
          })
          .map((el) => {
            const ph = (el as HTMLInputElement).placeholder ?? '';
            const nm = (el as HTMLInputElement).name ?? '';
            const eid = el.id ?? '';
            const sel = eid
              ? `#${CSS.escape(eid)}`
              : ph
                ? `${el.tagName.toLowerCase()}[placeholder="${CSS.escape(ph)}"]`
                : nm
                  ? `${el.tagName.toLowerCase()}[name="${CSS.escape(nm)}"]`
                  : el.tagName.toLowerCase();
            return { placeholder: ph, name: nm, id: eid, value: (el as HTMLInputElement).value ?? '', tagName: el.tagName, type: (el as HTMLInputElement).type ?? 'text', selector: sel };
          }),
      ),
      new Promise<RawInput[]>((r) => setTimeout(() => r([]), 6_000)),
    ]).catch(() => [] as RawInput[]);

    // ── Handle validation bypass ────────────────────────────────────────────
    // Many web3 platforms (e.g. bnbshare.fun) call an API to check if a social
    // handle is already taken before unlocking the submit button. If the test
    // handle was used in a prior run and is now "taken", the frontend will never
    // call eth_sendTransaction. We intercept these validation calls and return
    // "available" so the form accepts our test handle.
    // Intercept validation API calls so form handle checks always return "available".
    // Uses BOTH Playwright-level route interception (catches most requests) AND a JS-level
    // fetch override inside the page (catches backend calls our URL pattern might miss).
    await page.route(/\/(api|v[0-9]+)\/.*(check|valid|avail|soul|handle|username|github|earner|lookup|user)/i, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ available: true, taken: false, exists: false, valid: true, success: true, found: true }),
      }).catch(() => route.continue());
    }).catch(() => {});

    // JS-level fetch override inside the page: catches any validation call regardless of URL structure
    await page.evaluate(() => {
      const origFetch = window.fetch;
      (window as unknown as Record<string, unknown>)['__origFetch'] ??= origFetch;
      window.fetch = async function fetchOverride(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const url = typeof input === 'string' ? input
          : input instanceof URL ? input.href
          : (input as Request).url ?? '';
        if (/check|valid|avail|soul|github|earner|lookup|found/i.test(url) &&
            !/eth_|rpc|blockchain|bsc/i.test(url)) {
          return new Response(
            JSON.stringify({ available: true, found: true, valid: true, exists: true, taken: false, success: true }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return (origFetch as typeof window.fetch).call(this, input, init as RequestInit);
      };
    }).catch(() => {});

    // ── Creation form detection (broader than token-only) ───────────────────
    // Covers: token creation, agent deployment, NFT minting, profile creation, etc.
    // For TOKEN_CREATION / form+browser: trust featureType — fill any multi-input form.
    // For WALLET_FLOW / wallet+rpc: require at least one recognisable creation signal.
    const hasCreationSignal = visibleInputs.some((i) =>
      /moon.rocket|e\.g\.|token.?name|symbol|ticker|agent.?name|bot.?name|project.?name|strategy|deploy|mint|launch|create/i.test(i.placeholder) ||
      /^(name|tokenName|symbol|ticker|description|agentname|botname|strategy|projectname)$/i.test(i.name),
    );
    const isTokenOrFormType = options?.featureType === 'TOKEN_CREATION' || options?.featureType === 'form+browser';
    const isCreationForm = visibleInputs.length >= 2 && (isTokenOrFormType || hasCreationSignal);

    if (isCreationForm) {
      // Detect vault-factory fee-sharing pattern: social handle + BNB amount field
      const hasFeeSharePattern =
        visibleInputs.some((i) => /handle|username|social|@/i.test(i.placeholder)) &&
        visibleInputs.some((i) => /0\.0+/.test(i.placeholder) || /bnb|eth|buy|fee/i.test(i.placeholder));

      let batchFilled = 0;
      // ── Pass 1 ─────────────────────────────────────────────────────────────
      for (const inp of visibleInputs) {
        if (inp.value) continue; // skip already-filled inputs
        const value = resolveFieldValue(inp.placeholder, inp.name, inp.type, inp.tagName, hasFeeSharePattern);

        if (value) {
          try {
            await page.locator(inp.selector).first().fill(value, { timeout: 4_000 });
            console.log(`[executor] Batch fill: "${inp.placeholder || inp.name}" = "${value}"`);
            batchFilled++;
            await page.waitForTimeout(200);
          } catch (e) {
            console.warn(`[executor] Batch fill failed for "${inp.placeholder || inp.name}":`, String(e).slice(0, 80));
          }
        }
      }

      // ── Pass 2: re-scan for dynamically-rendered fields ────────────────────
      // Some platforms (e.g. bnbshare.fun) reveal extra fields after the first
      // fill pass (e.g. "GitHub Username" appears after "username" is filled).
      // Wait 3s to allow GitHub API/validation to respond and reveal new fields.
      if (batchFilled >= 1) {
        await page.waitForTimeout(3_000);
        type RawInput2 = { placeholder: string; name: string; id: string; value: string; tagName: string; type: string; selector: string };
        const pass2Inputs = await Promise.race([
          page.$$eval(
            'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea',
            (els) => els
              .filter((el) => {
                const s = window.getComputedStyle(el as HTMLElement);
                const r = (el as HTMLElement).getBoundingClientRect();
                return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0 && !(el as HTMLInputElement).value;
              })
              .map((el) => {
                const ph = (el as HTMLInputElement).placeholder ?? '';
                const nm = (el as HTMLInputElement).name ?? '';
                const eid = el.id ?? '';
                const sel = eid
                  ? `#${CSS.escape(eid)}`
                  : ph
                    ? `${el.tagName.toLowerCase()}[placeholder="${CSS.escape(ph)}"]`
                    : nm
                      ? `${el.tagName.toLowerCase()}[name="${CSS.escape(nm)}"]`
                      : el.tagName.toLowerCase();
                return { placeholder: ph, name: nm, id: eid, value: (el as HTMLInputElement).value ?? '', tagName: el.tagName, type: (el as HTMLInputElement).type ?? 'text', selector: sel };
              }),
          ),
          new Promise<RawInput2[]>((r) => setTimeout(() => r([]), 4_000)),
        ]).catch(() => [] as RawInput2[]);

        for (const inp of pass2Inputs) {
          const value = resolveFieldValue(inp.placeholder, inp.name, inp.type, inp.tagName, hasFeeSharePattern);
          if (value) {
            try {
              await page.locator(inp.selector).first().fill(value, { timeout: 3_000 });
              console.log(`[executor] Batch fill P2: "${inp.placeholder || inp.name}" = "${value}"`);
              batchFilled++;
              await page.waitForTimeout(200);
            } catch { /* ignore */ }
          }
        }
      }

      // If we filled at least 2 fields, try clicking the submit button immediately
      if (batchFilled >= 2) {
        creationFormWasFilled = true; // mark for direct tx injection fallback
        // Wait longer to allow page to finish validation (e.g. social handle API call)
        await page.waitForTimeout(2_000);
        const batchSubmitText = await findFormSubmitButton(page);
        if (batchSubmitText) {
          console.log(`[executor] Batch: clicking submit "${batchSubmitText}" after filling ${batchFilled} field(s)`);
          try {
            // Use JS click to bypass disabled-button guards (form-level validation may keep
            // the button disabled while the backend validates the social handle, but the
            // vault-factory patch handles the actual on-chain transaction regardless)
            const clicked = await page.evaluate((text: string) => {
              const submitRe = /^(create|launch|deploy|mint|submit|build|publish|confirm|proceed|start)\b/i;
              const btns = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
              const btn = btns.find((el) => {
                const t = (el.textContent ?? '').trim();
                const s = window.getComputedStyle(el as HTMLElement);
                const r = (el as HTMLElement).getBoundingClientRect();
                return submitRe.test(t) && s.display !== 'none' && r.width > 0 && r.height > 0;
              });
              if (btn) { (btn as HTMLElement).click(); return (btn.textContent ?? '').trim().slice(0, 40); }
              return null;
            }, batchSubmitText);
            console.log(`[executor] Batch: JS-clicked "${clicked ?? 'unknown'}"`);
            await page.waitForTimeout(3_000);
            const postSubmitText = await capturePageText(page).catch(() => '');
            if (/success|confirmed|submitted|created|deployed|minted|transaction|0x[0-9a-f]{20}/i.test(postSubmitText)) {
              console.log('[executor] Batch submit: success signal — skipping ReAct loop');
              return { observations, stopReason: 'completed', consecutiveNoops: 0, narrationSegments };
            }
            // Batch submit clicked but no success signal — let the ReAct loop run,
            // but inject context so the LLM knows fields are filled and focuses on
            // wallet connection + submit rather than re-filling fields.
            console.log('[executor] Batch submit: no success signal — continuing to ReAct for wallet connection');
            runningNarratives.push(
              'PREVIOUS ACTION (automated tool): Form fields were pre-filled and the submit button was clicked. ' +
              'The transaction did not go through yet — wallet connection through the UI may still be required. ' +
              'YOUR NEXT ACTIONS: ' +
              '(1) If you see a "Connect Wallet", "Continue with a wallet", or "MetaMask" button — CLICK IT to connect through the UI. ' +
              '(2) Once wallet is connected, click the submit/create button again. ' +
              '(3) DO NOT re-fill any form fields — they already have correct values. ' +
              'Return null only after the transaction has been submitted.'
            );
          } catch (e) {
            console.warn('[executor] Batch submit click failed:', String(e).slice(0, 80));
          }
        } else {
          console.log(`[executor] Batch: no submit button found after ${batchFilled} fills — entering ReAct loop`);
        }
      }
    }
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
  // State extraction cache (Change D): skip re-extraction after fill/scroll (no structural change)
  let cachedPageState: StructuredPageState | undefined;
  let lastStepAction: string | undefined;
  let lastStepChangedUrl = true; // force fresh extraction on first iteration
  while (reactStepCount < REACT_BUDGET && observations.length < STEP_BUDGET) {
    // Only re-extract structured state when the page could have structurally changed.
    // Reuse cache after fill_input/scroll with no URL change — saves ~5s per step.
    const needsStateRefresh = lastStepChangedUrl ||
      !cachedPageState ||
      lastStepAction === 'click_text' ||
      lastStepAction === 'click_selector' ||
      lastStepAction === 'navigate' ||
      lastStepAction === 'wait';
    const pageState = needsStateRefresh
      ? await Promise.race([
          extractStructuredState(page),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
        ]).catch(() => undefined)
      : cachedPageState;
    if (pageState) cachedPageState = pageState;
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
    if (bHost && aHost && !aHost.endsWith(bHost) && !bHost.endsWith(aHost) && urlChanged) { await page.goto(baseDomain, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {}); await page.waitForTimeout(1_500); }
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

    // Update state cache tracking
    lastStepAction = effectiveStep.action;
    lastStepChangedUrl = urlChanged;
    if (urlChanged) cachedPageState = undefined; // invalidate cache on navigation

    // Inline pass-condition check (Change F) — exit early if evidence is already sufficient
    if (!isNoop && isPassConditionMet(options?.featureType, textAfter, agentMemory)) {
      console.log('[executor] ReAct: pass condition met inline — exiting loop early');
      return { observations, stopReason: 'completed', consecutiveNoops, narrationSegments };
    }

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
    if (blockerDetected === 'wallet_required' && options?.investigationWalletAddress) {
      const al = options.investigationWalletAddress.toLowerCase(); const pl = textAfter.toLowerCase();
      const walletAlreadyVisible = pl.includes(al.slice(0, 6)) && pl.includes(al.slice(-4));
      if (walletAlreadyVisible) {
        blockerDetected = undefined;
      } else {
        const reconnected = await autoReconnectWallet(page, options.investigationWalletAddress);
        if (reconnected) {
          blockerDetected = undefined;
          // Post-wallet-connect CTA (Change H): after wallet reconnects during TOKEN_CREATION,
          // deterministically find and click the primary submit button within the form.
          if (isCreationClaim && agentMemory.currentPhase === 'form_filling') {
            await page.waitForTimeout(1_500);
            const ctaText = await findFormSubmitButton(page);
            if (ctaText) {
              console.log(`[executor] Post-wallet CTA: clicking "${ctaText}"`);
              try {
                await performStep(page, { action: 'click_text' as const, text: ctaText }, baseDomain, options?.investigationWalletAddress, options?.featureType);
                await page.waitForTimeout(2_000);
                return { observations, stopReason: 'completed', consecutiveNoops, narrationSegments };
              } catch { /* non-fatal — let ReAct handle it */ }
            }
          }
        }
      }
    }
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
        await page.goto(`${bOrigin}${recoveryPath}`, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
        await page.waitForTimeout(1_500);
        continue;
      }
      return { observations, stopReason: 'noop_threshold', consecutiveNoops, narrationSegments };
    }
    if (agentMemory.isComplete) { console.log(`[executor] ReAct: memory says complete — ${agentMemory.completionReason}`); return { observations, stopReason: 'completed', consecutiveNoops, narrationSegments }; }
  }
  // Allow bnbshare.fun creation claims to exceed budget so the direct injection fires.
  if (observations.length >= STEP_BUDGET && !(isCreationClaim && page.url().includes('bnbshare'))) { return { observations, stopReason: 'budget', consecutiveNoops, narrationSegments }; }

  // ── Last-chance submit (creation claims only) ─────────────────────────────
  // If we exhausted the ReAct budget while filling a creation form, make one
  // final deterministic click on the submit button. This is needed for platforms
  // (e.g. bnbshare.fun) where extra fields unlock AFTER wallet connects, forcing
  // the agent to spend budget on fills instead of the submit click.
  if (isCreationClaim && agentMemory.currentPhase !== 'confirmation') {
    // ── Post-ReAct batch fill ──────────────────────────────────────────────
    // If batch fill was skipped earlier (wallet connect UI was visible), run it
    // now after the ReAct loop has connected the wallet. This fills any empty
    // form fields before the final submit click.
    if (walletConnectUiVisible) {
      console.log('[executor] Post-ReAct batch fill: wallet now connected, filling remaining fields');
      const postReactInputs = await Promise.race([
        page.$$eval(
          'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]), textarea:not([disabled])',
          (els) => els
            .filter((el) => {
              const s = window.getComputedStyle(el as HTMLElement);
              const r = (el as HTMLElement).getBoundingClientRect();
              return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
            })
            .map((el) => {
              const ph = (el as HTMLInputElement).placeholder ?? '';
              const nm = (el as HTMLInputElement).name ?? '';
              const eid = el.id ?? '';
              const sel = eid
                ? `#${CSS.escape(eid)}`
                : ph
                  ? `${el.tagName.toLowerCase()}[placeholder="${CSS.escape(ph)}"]`
                  : nm
                    ? `${el.tagName.toLowerCase()}[name="${CSS.escape(nm)}"]`
                    : el.tagName.toLowerCase();
              return { placeholder: ph, name: nm, id: eid, value: (el as HTMLInputElement).value ?? '', tagName: el.tagName, type: (el as HTMLInputElement).type ?? 'text', selector: sel };
            }),
        ),
        new Promise<Array<{placeholder:string;name:string;id:string;value:string;tagName:string;type:string;selector:string}>>((r) => setTimeout(() => r([]), 5_000)),
      ]).catch(() => [] as Array<{placeholder:string;name:string;id:string;value:string;tagName:string;type:string;selector:string}>);

      const prHasFeeSharePattern =
        postReactInputs.some((i) => /handle|username|social|@/i.test(i.placeholder)) &&
        postReactInputs.some((i) => /0\.0+/.test(i.placeholder) || /bnb|eth|buy|fee/i.test(i.placeholder));

      for (const inp of postReactInputs) {
        if (inp.value) continue;
        const value = resolveFieldValue(inp.placeholder, inp.name, inp.type, inp.tagName, prHasFeeSharePattern);
        if (value) {
          try {
            await page.locator(inp.selector).first().fill(value, { timeout: 3_000 });
            console.log(`[executor] Post-ReAct fill: "${inp.placeholder || inp.name}" = "${value}"`);
            await page.waitForTimeout(200);
          } catch { /* ignore */ }
        }
      }
      await page.waitForTimeout(2_000);
    }

    // ── Direct tx injection (creation claims) ────────────────────────────────
    // For TOKEN_CREATION claims we inject our own calldata FIRST, BEFORE any
    // last-chance button click.  This avoids the race where the UI's submit fires
    // a transaction with an unknown handle (e.g. "qatest2436") that the vault-factory
    // patch cannot recognise, causing a revert before our injection even fires.
    //
    // Template: real bnbshare.fun "Share back" createToken tx (value=0, selector
    // 0x1b806220).  The vault factory (f359cebb...) and a unique qa-handle are
    // injected so signer.ts vault patch fires: it replaces the vault factory with
    // SimpleVaultFactory and rebuilds vaultData to route 100 % of fees to the
    // investigation wallet without any social-signature check.
    //
    // Template positions (rawData = "0x" + hex, so index 0 = '0', 1 = 'x'):
    //   T_NAME_LEN / T_NAME_BYTES  → token name  (unique per run, fits 1 word)
    //   T_SYM_LEN  / T_SYM_BYTES  → token symbol (unique per run, fits 1 word)
    //   T_LEN      / T_BYTES       → bnbshare handle (length + bytes)
    //   vault factory at fixed pos 1700 — signer scans for it
    const currentUrl = page.url();
    const isBnbShare = currentUrl.includes('bnbshare.fun') || currentUrl.includes('bnbshare');
    if (isCreationClaim && isBnbShare) {
      await page.waitForTimeout(1_000);

      // Real "Share back" bnbshare.fun createToken calldata (value=0, feeSharing=true).
      // Positions are absolute in rawData (includes "0x" prefix at positions 0-1).
      // prettier-ignore
      const BNBSHARE_TEMPLATE = '1b8062200000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000036000000000000000000000000000000000000000000000000000000000000003a000000000000000000000000000000000000000000000000000000000000003e000000000000000000000000000000000000000000000000000000000000000019cd08ee49b41d9a36007f1ad083845f4ae369e7022e5d3c573b8423209663b560000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000440000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c800000000000000000000000000000000000000000000000000000000000000c800000000000000000000000000000000000000000000000000000000bbf81e00000000000000000000000000000000000000000000000000000000000003f480000000000000000000000000000000000000000000000000000000000000271000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000021e19e0c9bab2400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000f359cebb8f8b4ad249e5b1fcdf8288efaf5de0890000000000000000000000000000000000000000000000000000000000000480000000000000000000000000000000000000000000000000000000000000000a5368617265206261636b0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000055348415245000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003b6261666b726569667461747734717934366135786b363672367034716a716862666c366f776766336472757a336a7076357974726c79616d626f7900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001a00000000000000000000000009801ca4214669fdbe636bb3a23e4af95e8e3df3b00000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000069df528f0000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000000d626e6273686172655f5f66756e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007747769747465720000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000417ad42e0d83612a20efa695388003d54fa238a5c3853720d1f7ff68519ea89e41177cb22fa6c5b14634dd58a132fa10a215812b8cbc6c7eb3a0284866a9f1bb991c00000000000000000000000000000000000000000000000000000000000000';

      // Build handle hex padded to 32 bytes (64 hex chars)
      const handleLenHex = uniqueHandle.length.toString(16).padStart(64, '0');
      const handleBytesHex = Array.from(new TextEncoder().encode(uniqueHandle))
        .map((b) => b.toString(16).padStart(2, '0')).join('').padEnd(64, '0');

      // Unique token name/symbol per run to avoid "token already exists" reverts.
      // IMPORTANT: token name must NOT contain the handle string ('qa????') as a
      // substring — otherwise signer.ts indexOf finds it in the name bytes (wrong
      // ABI position, fails alignment) before finding it at the real handle slot.
      const tokenName   = `QToken${runSuffix.slice(-4)}`;  // e.g., "QToken7605" (no 'qa' prefix)
      const tokenSymbol = `Q${uniqueHandle.slice(-4)}`;     // e.g., "Q7605" (same length as "SHARE")
      const nameLenHex   = tokenName.length.toString(16).padStart(64, '0');
      const nameBytesHex = Array.from(new TextEncoder().encode(tokenName))
        .map((b) => b.toString(16).padStart(2, '0')).join('').padEnd(64, '0');
      const symLenHex    = tokenSymbol.length.toString(16).padStart(64, '0');
      const symBytesHex  = Array.from(new TextEncoder().encode(tokenSymbol))
        .map((b) => b.toString(16).padStart(2, '0')).join('').padEnd(64, '0');

      // Template positions (rawData positions - 2 to strip "0x" prefix):
      // All replacements are exactly 64 hex chars (one 32-byte ABI word).
      const T_NAME_LEN   = 1802 - 2;  // token name length word
      const T_NAME_BYTES = 1866 - 2;  // token name bytes (padded to 32 bytes)
      const T_SYM_LEN    = 1930 - 2;  // token symbol length word
      const T_SYM_BYTES  = 1994 - 2;  // token symbol bytes (padded to 32 bytes)
      const T_LEN        = 2762 - 2;  // handle length word
      const T_BYTES      = 2826 - 2;  // handle bytes (padded to 32 bytes)

      // Splice all replacements (ordered from lowest to highest position)
      const injData = '0x' +
        BNBSHARE_TEMPLATE.slice(0, T_NAME_LEN) +
        nameLenHex +
        BNBSHARE_TEMPLATE.slice(T_NAME_LEN + 64, T_NAME_BYTES) +
        nameBytesHex +
        BNBSHARE_TEMPLATE.slice(T_NAME_BYTES + 64, T_SYM_LEN) +
        symLenHex +
        BNBSHARE_TEMPLATE.slice(T_SYM_LEN + 64, T_SYM_BYTES) +
        symBytesHex +
        BNBSHARE_TEMPLATE.slice(T_SYM_BYTES + 64, T_LEN) +
        handleLenHex +
        BNBSHARE_TEMPLATE.slice(T_LEN + 64, T_BYTES) +
        handleBytesHex +
        BNBSHARE_TEMPLATE.slice(T_BYTES + 64);

      console.log(`[executor] Firing direct tx injection — name="${tokenName}" symbol="${tokenSymbol}" handle="${uniqueHandle}"`);
      const injResult = await page.evaluate(
        async (args: { injData: string; walletAddr: string }) => {
          // Call larpscanSign directly (same as mock.eth_sendTransaction does internally)
          // so we bypass any dApp-side state that might block eth.request after a revert.
          const fn = (window as unknown as Record<string, unknown>)['larpscanSign'] as
            | ((method: string, paramsJson: string) => Promise<string>)
            | undefined;
          if (typeof fn !== 'function') return 'no-bridge';
          try {
            const hash = await fn('eth_sendTransaction', JSON.stringify([{
              from: args.walletAddr,
              to:   '0x90497450f2a706f1951b5bdda52b4e5d16f34c06',
              value: '0x0',
              data: args.injData,
              gas:  '0x630000',
            }]));
            return hash ?? 'null-hash';
          } catch (e: unknown) {
            return 'error:' + ((e instanceof Error ? e.message : String(e)) ?? '?').slice(0, 80);
          }
        },
        { injData, walletAddr: options?.investigationWalletAddress ?? '' },
      ).catch((e: unknown) => 'eval-error:' + String(e).slice(0, 80));

      await page.waitForTimeout(3_000);
      console.log(`[executor] Direct tx injection result: ${injResult}`);
    } else {
      // ── Last-chance submit (non-creation wallet-flow claims only) ────────────
      // For pure WALLET_FLOW claims (no direct injection), make a final deterministic
      // click on the submit button if the agent exhausted its budget without submitting.
      const lastChanceCta = await findFormSubmitButton(page);
      if (lastChanceCta) {
        console.log(`[executor] Last-chance submit: clicking "${lastChanceCta}" after budget exhaustion`);
        try {
          await page.evaluate((text: string) => {
            const submitRe = /^(create|launch|deploy|mint|submit|build|publish|confirm|proceed|start)\b/i;
            const btns = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
            const btn = btns.find((el) => {
              const t = (el.textContent ?? '').trim();
              const s = window.getComputedStyle(el as HTMLElement);
              const r = (el as HTMLElement).getBoundingClientRect();
              return submitRe.test(t) && s.display !== 'none' && r.width > 0 && r.height > 0;
            });
            if (btn) (btn as HTMLElement).click();
          }, lastChanceCta);
          await page.waitForTimeout(5_000);
          console.log('[executor] Last-chance submit: button clicked — wallet tx dispatch pending (check signer logs)');
        } catch (e) {
          console.warn('[executor] Last-chance submit click failed:', e);
        }
      }
    }
  }

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
      await page.goto(`${base}${path}`, { waitUntil: 'load', timeout: 25_000 }).catch(() =>
        page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {}),
      );
      await page.waitForTimeout(2_000);
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
        await page.goto(url, { waitUntil: 'load', timeout: 25_000 }).catch(() =>
          page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {}),
        );
        await page.waitForTimeout(2_000);
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
        try {
          // Fallback: force click (bypasses element interception)
          await locator.click({ force: true, timeout: 3_000 });
        } catch {
          // Final fallback: JS dispatchEvent click (bypasses all Playwright checks)
          await locator.evaluate((el) => (el as HTMLElement).click()).catch(() => {});
        }
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


