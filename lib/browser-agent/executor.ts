import type { Page, BrowserContext } from 'playwright';
import OpenAI from 'openai';
import type { AgentObservation, AgentStep, BlockerType, PageMessage, PageState, WorkflowStage } from './types';
import { analyzePageState, capturePageText } from './page-analysis';
import {
  FEE_SHARE_SOCIAL_HANDLE_FILL_TOKEN,
  FEE_SHARE_X_HANDLE_VALUE,
  INVESTIGATION_WALLET_FILL_TOKEN,
} from './constants';
import type { WorkflowHypothesis } from './workflow';
import { classifyStepOutcome } from './workflow';
import { generateFakeTokenPng } from '../utils/fake-png';
import { triggerWalletReconnect, tryPickWalletInModal, autoReconnectWallet } from './wallet-reconnect';
import { dismissConsentBanner } from './evidence';

// ─────────────────────────────────────────────────────────────────────────────
// Safety guard
// ─────────────────────────────────────────────────────────────────────────────

const BLOCKED_PATTERNS = [
  // English — dangerous wallet/transaction actions
  // NOTE: "connect wallet" is intentionally ALLOWED — the agent needs to click
  // it to trigger our injected wallet mock for verification.
  /\bsign\b/i, /\bapprove\b/i, /confirm transaction/i,
  /\bbuy\b/i, /\bsell\b/i, /execute swap/i, /seed phrase/i, /private key/i, /\bpay\b/i,
  // Traditional Chinese — equivalent dangerous actions
  /簽名/, /簽署/, /批准/, /授權交易/,
  /確認交易/, /執行兌換/, /購買代幣/, /出售代幣/, /助記詞/, /私鑰/, /支付/,
];

function isSafeToInteract(text: string): boolean {
  return !BLOCKED_PATTERNS.some((re) => re.test(text));
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

function substituteFeeShareSocialHandle(step: AgentStep, handle: string): AgentStep {
  if (!handle || step.action !== 'fill_input') return step;
  const v = step.value;
  if (typeof v !== 'string' || !v.includes(FEE_SHARE_SOCIAL_HANDLE_FILL_TOKEN)) return step;
  return { ...step, value: v.split(FEE_SHARE_SOCIAL_HANDLE_FILL_TOKEN).join(handle) };
}

const DEV_BUY_PATTERN = /dev.?buy|initial.?buy|launch.?buy|buy.?amount|purchase.?amount/i;

/** Force dev buy / initial purchase fields to "0" based on the selector text. */
function substituteDevBuyToZero(step: AgentStep): AgentStep {
  if (step.action !== 'fill_input') return step;
  const selector = (step.selector ?? '').toLowerCase();
  const value    = (typeof step.value === 'string' ? step.value : '').toLowerCase();
  // Also catch the case where the LLM fills a generic 'amount' field with a
  // BNB-style float (e.g. "0.5", "1.0") inside a TOKEN_CREATION context.
  if (DEV_BUY_PATTERN.test(selector) || DEV_BUY_PATTERN.test(value)) {
    console.log(`[executor] Dev buy override: selector="${step.selector}" value="${step.value}" → "0"`);
    return { ...step, value: '0' };
  }
  return step;
}

/** Applies wallet + fee-share + dev-buy tokens in order for fill_input steps */
function applyFillInputSubstitutions(step: AgentStep, opts?: { investigationWalletAddress?: string }): AgentStep {
  let s = substituteInvestigationWallet(step, opts?.investigationWalletAddress);
  s = substituteFeeShareSocialHandle(s, FEE_SHARE_X_HANDLE_VALUE);
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
  runningNarratives:  string[],  // one entry per past step — what happened + what page said
  walletAddress?:     string,
  featureType?:       string,
): Promise<AgentStep | null> {
  // Capture screenshot + buttons + page messages + live form fields in parallel.
  // The screenshot gives the model full visual context — it can see below-fold
  // buttons, loaded previews, and UI state a text snippet would miss entirely.
  // The page messages tell it what the page is explicitly communicating right now.
  // liveFormFields provides EXACT CSS selectors so the model never has to guess them.
  const [screenshotBuf, btns, currentMessages, liveFormFields] = await Promise.all([
    page.screenshot({ type: 'jpeg', quality: 60, fullPage: false }).catch(() => null as Buffer | null),
    page.$$eval(
      'button:not([disabled]), [role="button"]:not([aria-disabled="true"])',
      (els) => els
        .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 10),
    ).catch(() => [] as string[]),
    capturePageMessages(page),
    page.$$eval(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([disabled]), textarea:not([disabled])',
      (els) => els
        .filter((el) => {
          const s = window.getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden';
        })
        .map((el) => {
          const ph  = (el as HTMLInputElement).placeholder ?? '';
          const nm  = (el as HTMLInputElement).name ?? '';
          const sel = nm ? `[name="${nm}"]` : ph ? `[placeholder="${ph}"]` : 'input';
          const val = ((el as HTMLInputElement).value ?? '').trim();
          return `${sel}${val ? ` (currently: "${val.slice(0, 20)}")` : ' (empty)'}`;
        })
        .slice(0, 14),
    ).catch(() => [] as string[]),
  ]);

  const url = page.url();

  // Current page message summary (what the page is saying right now)
  const currentMsgStr = currentMessages.length
    ? currentMessages.map((m) => `  [${m.type.toUpperCase()}] ${m.text}`).join('\n')
    : '  (none)';

  const tokenCreationExtra = featureType === 'TOKEN_CREATION' ? `
TOKEN_CREATION CRITICAL RULES (override everything else):
- A "Connect your wallet" message or "wallet_required" status does NOT mean the form is unusable.
  Wallet auth only blocks the final SUBMIT — the input fields themselves are always fillable.
- If you see ANY input fields (Token Name, Symbol, Twitter handle, etc.), fill them NOW.
  Do NOT return null just because a wallet connection message is visible.
- Fill order: Token Name → Token Symbol → Description → Website → Twitter → Telegram →
  scroll down → Dev Buy (set to "0") → Enable Fee Sharing (click toggle) → Twitter/X handle.
- After all fields are filled, click the "Create Token" submit button.
- If submit fails due to wallet auth, that is still valid evidence — do NOT return null before trying.
` : '';

  const SYSTEM = `You are a smart human QA tester. Think like a human reading the page.
You are given a screenshot of the current state AND a step-by-step narrative of what has happened.
${tokenCreationExtra}
CRITICAL — READ THE PAGE MESSAGES before deciding anything:
- If a message says "error" or "failed" → identify WHY and fix it (fill a missing field, change a value)
- If a message says "success", "confirmed", "created", "minted" → the objective is achieved → return null
- If a message says "warning" → note it but try to proceed unless it's blocking

FORM INVENTORY (do this mentally before each decision):
1. Look at the screenshot — list all visible input fields and which are filled vs empty
2. Fill fields in top-to-bottom order before clicking any submit button
3. For social handle / username / Twitter / X handle fields → value must be "testuser"
4. If you see a toggle labelled "Enable Fee Sharing", "Fee sharing", or similar → click it BEFORE filling the handle field
5. Only click create / submit / launch / mint / deploy AFTER all visible fields are filled

ANTI-PATTERNS (never do these):
- Click "Create Token" / "Launch" / "Deploy" when any required field is still empty
- Repeat an action already listed in the narrative
- Scroll when the target input is already visible on screen
- Click "Sign", "Approve", MetaMask, or WalletConnect buttons (but "Connect Wallet" IS allowed)

SPECIFIC ERROR RECOVERY:
- If you see "transaction value exceeds safety limit" or "exceeds safety limit" →
  find the "Dev Buy" or any optional purchase-amount input field and set its value to "0",
  then click the submit/create button again. The dev buy is optional and can be skipped.

Return the single best next action as JSON:
  {"action":"click_text","text":"<exact button label>"}
  {"action":"fill_input","selector":"<css selector>","value":"<value>"}
  {"action":"scroll","direction":"down","amount":400}
  {"action":"navigate","path":"/<path>"}
  null   ← use when objective is achieved OR you are truly stuck

Rules:
- NEVER repeat an action already in the narrative
- NEVER click "Sign in", "Sign", "Approve", MetaMask, or WalletConnect
- You ARE allowed to click "Connect Wallet" or "Connect Wallet to Continue" if it is the only way to proceed
- Look at the screenshot for buttons not in the button list
- Read instructions/labels on the page — they tell you what to fill in next
- Return null if pass condition is clearly met`;

  const textContext = [
    `Claim: ${claim}`,
    `Pass condition: ${passCondition}`,
    `URL: ${url}`,
    walletAddress ? `Wallet: ${walletAddress.slice(0, 10)}… (connected — click "Connect Wallet" buttons if they block progress, the system handles the rest)` : '',
    '',
    `What has happened so far (most recent last):`,
    runningNarratives.slice(-5).map((n, i) => `  ${i + 1}. ${n}`).join('\n') || '  (nothing yet)',
    '',
    `What the page is saying RIGHT NOW:`,
    currentMsgStr,
    '',
    `Visible enabled buttons: [${btns.join(' | ')}]`,
    liveFormFields.length > 0
      ? `\nActual form field selectors (use EXACTLY these for fill_input — do NOT invent selectors):\n${liveFormFields.map((f) => `  ${f}`).join('\n')}`
      : '',
  ].filter((l) => l !== undefined).join('\n');

  // Build multimodal content when screenshot is available; fall back to text-only
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
      model:       'gpt-4o-mini',
      temperature: 0,
      max_tokens:  300,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: userContent as string },  // SDK accepts both shapes
      ],
    });

    const raw = (resp.choices[0]?.message?.content ?? '').trim();
    if (!raw || raw === 'null') return null;

    const parsed = JSON.parse(raw) as AgentStep;
    if (!parsed?.action) return null;
    return parsed;
  } catch {
    return null;  // never block the run on an adaptive failure
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

    let value: string;
    if (
      /twitter|github|tiktok|twitch|instagram|social|handle|username|creator|x\.com|@/i.test(hint)
    ) {
      value = FEE_SHARE_SOCIAL_HANDLE_FILL_TOKEN;
    } else if (/wallet|address|recipient|0x/i.test(hint)) {
      value = walletAddress ? INVESTIGATION_WALLET_FILL_TOKEN : '';
    } else if (inp.type === 'email') {
      value = 'test@example.com';
    } else if (inp.type === 'url' || /website|url|link/i.test(hint)) {
      value = 'https://example.com';
    } else if (/dev.?buy|initial.?buy|launch.?buy|buy.?amount|purchase.?amount/i.test(hint)) {
      // Dev buy / initial purchase on token launch forms: always 0.
      // A non-zero value inflates the transaction amount and may exceed safety limits.
      value = '0';
    } else if (inp.type === 'number' || /amount|quantity|count|num/i.test(hint)) {
      value = '100';
    } else {
      value = 'Test input';
    }

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
}

const STEP_BUDGET = 15;  // raised from 10 — complex flows need more headroom

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
  },
): Promise<ExecuteResult> {
  const observations: AgentObservation[] = [];
  let consecutiveNoops  = 0;
  let adaptiveCallCount = 0;
  const NOOP_THRESHOLD  = 3;
  // TOKEN_CREATION flows require many adaptive steps: fill name, symbol, description,
  // scroll, click fee-sharing toggle, fill handle, click submit — 9-11 decisions minimum.
  // Other feature types rarely need more than 5.
  const MAX_ADAPTIVE = options?.featureType === 'TOKEN_CREATION' ? 12 : 5;

  // TOKEN_CREATION ReAct switch flag: set to true after we land on a form surface,
  // at which point the static plan is discarded and every step is decided adaptively.
  let reactSwitchActivated = false;

  // Running narrative — one entry per executed step, built with buildStepNarrative().
  // Passed to decideAdaptiveStep so the LLM knows what has happened AND what the
  // page said at each step, just like a human tester's mental model.
  const runningNarratives: string[] = [];

  // Use a mutable queue so we can dynamically inject steps discovered
  // after content loads (e.g. Mint button revealed after Preview completes).
  const stepsToRun: AgentStep[] = [...steps];

  // Dismiss cookie/GDPR banners once before the first step
  await dismissConsentBanner(page);

  // ── Main adaptive execution loop ────────────────────────────────────────
  // Why while(true) instead of for…of:
  //   • When the queue empties, we can ask the LLM for the next step instead
  //     of stopping — enabling true observe → decide → act behaviour.
  //   • The loop has explicit exit conditions so it can't run forever.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // ── Determine next step ──────────────────────────────────────────────
    let step: AgentStep | undefined;

    if (stepsToRun.length > 0) {
      step = stepsToRun.shift();
    } else if (adaptiveCallCount < MAX_ADAPTIVE && observations.length < STEP_BUDGET) {
      // ── TOKEN_CREATION forced form-fill pass ──────────────────────────────
      // When the plan queue empties on a TOKEN_CREATION run and no form fields
      // have been filled yet, perform an immediate scan-and-fill of ALL visible
      // inputs. This handles the case where SIWE auth is blocked (e.g. Privy
      // returning 403 from datacenter IPs) but the form inputs are still
      // interactable — wallet-gating only prevents submission, not field entry.
      // TOKEN_CREATION one-shot form-fill pass — runs exactly once (adaptiveCallCount === 0),
      // then adaptiveCallCount is incremented so the condition never fires again.
      if (
        options?.featureType === 'TOKEN_CREATION' &&
        adaptiveCallCount === 0
      ) {
        adaptiveCallCount++;  // consume one adaptive slot so this never loops
        const visibleInputs = await page.$$eval(
          'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([disabled]), textarea:not([disabled])',
          (els) => els.filter((el) => {
            const s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' &&
              (el as HTMLInputElement).offsetWidth > 0;
          }).length,
        ).catch(() => 0);

        if (visibleInputs > 0) {
          console.log(`[executor] TOKEN_CREATION form-fill pass: ${visibleInputs} visible input(s) found — scanning and filling`);
          const fillSteps = await detectNewFormFields(
            page,
            [],  // treat all inputs as "new" so nothing is skipped
            stepsToRun,
            options?.investigationWalletAddress,
            12,  // lift cap so all fields (including social handles) are covered
          );
          if (fillSteps.length > 0) {
            console.log(`[executor] TOKEN_CREATION form-fill pass: injecting ${fillSteps.length} fill step(s)`);
            stepsToRun.unshift(...fillSteps);
            continue;  // queue now has fill steps — re-enter to execute them
          }
        }
        // no inputs found — fall through to normal adaptive step below
      }

      // Queue empty but budget remains — ask the LLM what to do next.
      console.log(`[executor] Queue empty — calling adaptive step decision (call ${adaptiveCallCount + 1}/${MAX_ADAPTIVE})`);
      const adaptive = await decideAdaptiveStep(
        page,
        options?.claim        ?? '',
        options?.passCondition ?? '',
        runningNarratives,
        options?.investigationWalletAddress,
        options?.featureType,
      ).catch(() => null);
      adaptiveCallCount++;
      if (!adaptive) {
        console.log('[executor] Adaptive decision returned null — stopping');
        break;
      }
      console.log(`[executor] Adaptive step: ${JSON.stringify(adaptive)}`);
      step = adaptive;
    } else {
      break;  // no more steps and no adaptive budget — done
    }

    if (!step) break;

    const effectiveStep = applyFillInputSubstitutions(step, options);
    console.log('[executor] Executing:', effectiveStep);

    // ── Pre-action snapshot ─────────────────────────────────────────────────
    const urlBefore      = page.url();
    const modalBefore    = await hasModalOpen(page);
    const headingsBefore = await getVisibleHeadings(page);
    const inputsBefore   = await getVisibleInputLabels(page);
    const formBefore     = await getFormProgressSnapshot(page);
    const enabledBtnsBefore = await page.$$eval(
      'button:not([disabled]), [role="button"]:not([aria-disabled="true"])',
      (els) => els.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean),
    ).catch(() => [] as string[]);
    const textBefore     = await capturePageText(page);
    const scrollBefore   = await getScrollY(page);
    const apisBefore     = runApiBuffer.length;

    let obs: Partial<AgentObservation> = { step: stepLabel(effectiveStep), isNoop: true };
    let stepSucceeded = false;

    let loadingTriggered = false;

    try {
      // ── Execute action ────────────────────────────────────────────────────
      await performStep(page, effectiveStep, baseDomain, options?.investigationWalletAddress);
      stepSucceeded = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      obs.result = `Step error: ${msg}`;
      console.error('[executor] Step error:', e);
    }

    // ── Post-action snapshot ─────────────────────────────────────────────────
    // For click actions, wait for any loading/spinner states to resolve before
    // taking the snapshot — a human tester would watch the spinner and wait.
    // For other actions keep the fixed baseline wait.
    if (
      stepSucceeded &&
      (effectiveStep.action === 'click_text' || effectiveStep.action === 'click_selector')
    ) {
      await page.waitForTimeout(1_500);  // give SPA time to mount spinner before first poll
      loadingTriggered = await waitForPageStable(page);
      if (loadingTriggered) {
        console.log('[executor] Detected loading state after click — waited for page to stabilize');
        // After content loads, scroll down to reveal anything below the fold.
        // A human tester naturally scrolls after a preview/result appears —
        // e.g. the Mint button that sits below the soul-preview card on Ensoul /mint.
        await page.evaluate(() => window.scrollBy({ top: 400, behavior: 'smooth' })).catch(() => {});
        await page.waitForTimeout(600);
        // If there's still more page below, scroll a second time
        const scrolledEnough = await page.evaluate(() => {
          const { scrollTop, scrollHeight, clientHeight } = document.documentElement;
          return scrollTop + clientHeight >= scrollHeight - 100;
        }).catch(() => true);
        if (!scrolledEnough) {
          await page.evaluate(() => window.scrollBy({ top: 400, behavior: 'smooth' })).catch(() => {});
          await page.waitForTimeout(400);
        }

        // ── Auto-inject progression steps revealed by the loading ───────────
        // Pass 1: pattern / newness detection (free, instant).
        // Pass 2: adaptive LLM decision if Pass 1 found nothing (handles non-
        //   standard button text that PROGRESSION_BTN_RE would miss).
        if (observations.length < STEP_BUDGET - 2) {
          const autoSteps = await detectAutoProgressionSteps(
            page, enabledBtnsBefore, stepsToRun,
          );
          if (autoSteps.length > 0) {
            // Insert at front so post-load CTAs run before remaining planned steps
            stepsToRun.unshift(...autoSteps);
            console.log(
              `[executor] Auto-injected ${autoSteps.length} post-load step(s):`,
              autoSteps.map((s) => JSON.stringify(s)).join(', '),
            );
          } else if (adaptiveCallCount < MAX_ADAPTIVE && options?.claim) {
            // No new button matched — ask LLM to interpret the new content
            console.log('[executor] No auto-CTA after load — asking adaptive LLM');
            const adaptive = await decideAdaptiveStep(
              page,
              options.claim,
              options.passCondition ?? '',
              runningNarratives,
              options.investigationWalletAddress,
              options.featureType,
            ).catch(() => null);
            adaptiveCallCount++;
            if (adaptive) {
              stepsToRun.unshift(adaptive);
              console.log(`[executor] Adaptive post-load step: ${JSON.stringify(adaptive)}`);
            }
          }
        }
      }
    } else if (stepSucceeded && effectiveStep.action === 'scroll') {
      // After a scroll, give the page a moment to paint newly revealed content,
      // then scan for form fields that weren't visible before the scroll.
      // This is the mechanism that finds below-fold inputs (e.g. the social
      // handle field on bnbshare.fun) that the planner never saw at planning time.
      await page.waitForTimeout(800);
      if (observations.length < STEP_BUDGET - 2) {
        const newFieldSteps = await detectNewFormFields(
          page, inputsBefore, stepsToRun, options?.investigationWalletAddress,
        );
        if (newFieldSteps.length > 0) {
          stepsToRun.unshift(...newFieldSteps);
          console.log(
            `[executor] Scroll revealed ${newFieldSteps.length} new field(s) — injecting:`,
            newFieldSteps.map((s) => JSON.stringify(s)).join(', '),
          );
        }
      }
    } else {
      await page.waitForTimeout(1_500);
    }

    const urlAfter      = page.url();
    const modalAfter    = await hasModalOpen(page);
    const headingsAfter = await getVisibleHeadings(page);
    const inputsAfter   = await getVisibleInputLabels(page);
    const formAfter     = await getFormProgressSnapshot(page);
    const enabledBtnsAfter = await page.$$eval(
      'button:not([disabled]), [role="button"]:not([aria-disabled="true"])',
      (els) => els.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean),
    ).catch(() => [] as string[]);
    const textAfter     = await capturePageText(page);
    const scrollAfter   = await getScrollY(page);
    const stepApiCalls  = runApiBuffer.slice(apisBefore);

    const urlChanged     = urlAfter !== urlBefore;
    const modalOpened    = !modalBefore && modalAfter;
    const newInputs      = inputsAfter.filter((i) => !inputsBefore.includes(i));
    const visibleSignals = headingsAfter.filter((h) => !headingsBefore.includes(h));
    const pageTextDiff   = Math.abs(textAfter.length - textBefore.length);
    const ctaStateChanged =
      enabledBtnsAfter.length !== enabledBtnsBefore.length ||
      enabledBtnsAfter.some((b) => !enabledBtnsBefore.includes(b));
    const scrollChanged = Math.abs(scrollAfter - scrollBefore) > 80;
    const formProgressed =
      formAfter.inputCount !== formBefore.inputCount ||
      formAfter.requiredCount !== formBefore.requiredCount ||
      formAfter.enabledSubmitCount !== formBefore.enabledSubmitCount ||
      formAfter.stepperHints.join('|') !== formBefore.stepperHints.join('|');

    // ── No-op detection ──────────────────────────────────────────────────────
    // fill_input and scroll are intrinsic: they always change state (input value
    // or scroll position) even when other DOM signals don't fire, so they should
    // never be counted as no-ops.
    //
    // click_text and click_selector are NOT intrinsic — a click on a disabled
    // button, a purely decorative element, or an already-open modal produces no
    // observable change. Removing them from intrinsic lets the diff signals
    // (urlChanged, ctaStateChanged, loadingTriggered, etc.) correctly classify
    // whether the click did anything, keeping the noop counter accurate for
    // recovery/replanning decisions.
    // ── Read page messages early — needed for immediate error recovery ────────
    // Moved before the noop block so that when a step produces no observable DOM
    // change but the page is showing an error, we can act on it immediately
    // instead of waiting for the 3-noop threshold.
    const stepMessages = await capturePageMessages(page);

    const isIntrinsicProgressAction =
      stepSucceeded &&
      (step.action === 'fill_input' ||
       step.action === 'scroll');

    const isNoop =
      !isIntrinsicProgressAction &&
      !loadingTriggered &&
      !urlChanged &&
      !modalOpened &&
      newInputs.length === 0 &&
      stepApiCalls.length === 0 &&
      visibleSignals.length === 0 &&
      !ctaStateChanged &&
      !formProgressed &&
      !scrollChanged &&
      pageTextDiff < 50;

    if (isNoop) {
      consecutiveNoops++;
      console.log(`[executor] Step had no observable effect (consecutive noops: ${consecutiveNoops})`);

      // Immediate error-driven recovery: if the page is explicitly showing an
      // error message right now, don't wait for 3 noops — act on it immediately.
      // A human tester reads the error and fixes it straight away.
      if (
        stepMessages.some((m) => m.type === 'error') &&
        adaptiveCallCount < MAX_ADAPTIVE &&
        options?.claim &&
        stepsToRun.length === 0
      ) {
        console.log('[executor] Noop with visible error — calling adaptive immediately to fix it');
        const fix = await decideAdaptiveStep(
          page,
          options.claim,
          options.passCondition ?? '',
          runningNarratives,
          options.investigationWalletAddress,
          options.featureType,
        ).catch(() => null);
        if (fix) {
          stepsToRun.unshift(fix);
          consecutiveNoops = 0;
          adaptiveCallCount++;
          console.log(`[executor] Immediate error recovery step: ${JSON.stringify(fix)}`);
        }
      }
    } else {
      consecutiveNoops = 0;
    }

    // ── Handle modal auto-fill if modal opened ───────────────────────────────
    let modalFilled: string[] = [];
    if (modalOpened) {
      modalFilled = await fillModalInputs(page);
    }

    // ── Blocker detection ────────────────────────────────────────────────────
    let blockerDetected = detectBlockerFromText(textAfter);

    // Suppress wallet_required when the investigation wallet address is visible
    // in the page text. Require BOTH prefix and suffix to avoid false positives
    // from short hex strings that coincidentally appear in other content.
    if (blockerDetected === 'wallet_required' && options?.investigationWalletAddress) {
      const addrLower = options.investigationWalletAddress.toLowerCase();
      const short     = addrLower.slice(0, 6);
      const end       = addrLower.slice(-4);
      const pageLower = textAfter.toLowerCase();
      if (pageLower.includes(short) && pageLower.includes(end)) {
        blockerDetected = undefined;
      }
    }

    if (blockerDetected === 'wallet_required' && options?.investigationWalletAddress) {
      console.log('[executor] wallet_required detected mid-execution — auto-reconnecting');
      blockerDetected = await autoReconnectWallet(page, options.investigationWalletAddress)
        ? undefined
        : blockerDetected;
    }

    const workflowStructureVisible =
      inputsAfter.length > 0 ||
      headingsAfter.some((h) => /form|create|launch|dashboard|leaderboard|swap|mine|claim|創建|表單|儀表板|排行榜|兌換|挖礦|領取/i.test(h));
    const likelyAuthWall = /sign in|log in|\blogin\b|登入|登錄|請登入/.test(textAfter);
    if (likelyAuthWall && workflowStructureVisible && blockerDetected === 'auth_required') {
      // Auth can be part of a real workflow; avoid over-classifying as a hard blocker.
      blockerDetected = undefined;
    }
    if (
      (step.action === 'navigate' || step.action === 'open_link_text') &&
      urlChanged &&
      inputsAfter.length === 0 &&
      headingsAfter.length === 0 &&
      textAfter.trim().length < 160
    ) {
      blockerDetected = blockerDetected ?? 'route_missing';
    }
    if (
      (step.action === 'click_text' || step.action === 'click_selector') &&
      isNoop &&
      consecutiveNoops >= 2 &&
      !workflowStructureVisible
    ) {
      blockerDetected = blockerDetected ?? 'feature_disabled';
    }
    const outcomeClass = classifyStepOutcome({
      step,
      urlChanged,
      modalOpened,
      newInputs,
      apiCalls: stepApiCalls,
      visibleSignals,
      blockerDetected,
      isNoop,
      currentUrl: urlAfter,
      likelySurface: options?.hypothesis?.likelySurface,
      visibleInputCount: inputsAfter.length,
    });
    const surfaceMatch: 'exact' | 'fallback' | 'wrong' = (() => {
      const likely = options?.hypothesis?.likelySurface;
      if (!likely) return urlChanged ? 'fallback' : 'exact';
      if (urlAfter.includes(likely)) return 'exact';
      return urlChanged ? 'fallback' : 'wrong';
    })();

    // ── TOKEN_CREATION ReAct switch ──────────────────────────────────────────
    // The static plan was generated from an above-fold snapshot — it never saw
    // below-fold fields (fee-sharing toggle, social handle). Once we land on the
    // form surface, discard the remaining static steps and switch to pure
    // adaptive: every subsequent step is decided from the actual live page state.
    if (
      !reactSwitchActivated &&
      options?.featureType === 'TOKEN_CREATION' &&
      (effectiveStep.action === 'navigate' || effectiveStep.action === 'open_link_text') &&
      urlChanged &&
      inputsAfter.length >= 2
    ) {
      reactSwitchActivated = true;
      const discarded = stepsToRun.splice(0);
      adaptiveCallCount = 0;  // full fresh budget for the form-filling phase
      console.log(
        `[executor] TOKEN_CREATION ReAct switch activated — discarded ${discarded.length} static step(s), switching to pure adaptive`,
      );
    }

    // ── Build observation ────────────────────────────────────────────────────
    obs = {
      ...obs,
      isNoop,
      stage:           options?.stage ?? 'execution',
      outcomeClass,
      url:             urlAfter,
      urlChanged,
      modalOpened,
      ctaStateChanged,
      surfaceMatch,
      newInputs,
      apiCalls:        stepApiCalls.slice(0, 8),
      visibleSignals,
      blockerDetected,
      pageText:        textAfter.slice(0, 400),
      messages:        stepMessages.length ? stepMessages : undefined,
      result: obs.result ?? buildResultMessage(step, urlChanged, modalOpened, modalFilled, newInputs, visibleSignals, stepApiCalls, isNoop),
    };

    // Build human-readable narrative and append to running history.
    // This is what a human tester would mentally note after each step:
    // "Clicked Preview → soul card loaded, page says [INFO] Profile found"
    const builtObs = obs as AgentObservation;
    builtObs.narrative = buildStepNarrative(builtObs);
    runningNarratives.push(builtObs.narrative);

    observations.push(builtObs);

    const msgLog = stepMessages.length
      ? ` | messages=[${stepMessages.map((m) => `${m.type}:"${m.text.slice(0, 60)}"`).join(', ')}]`
      : '';
    console.log(
      `[executor] → urlChanged=${urlChanged} modal=${modalOpened} noops=${consecutiveNoops} ` +
      `apiCalls=${stepApiCalls.length} signals=${visibleSignals.length} noop=${isNoop}${msgLog}`,
    );

    // ── Stopping rules ───────────────────────────────────────────────────────

    // Early success: if the pass condition appears satisfied in the current
    // page text OR a success message was captured, stop spending budget.
    //
    // Guard: require at least one meaningful interaction (fill_input or a
    // non-wallet click_text) before allowing passConditionMet to fire.
    // Without this, navigating to a form page whose text happens to contain
    // all pass-condition keywords would stop the agent immediately — before it
    // has filled any fields or attempted a transaction.
    // Has the agent done at least one meaningful interaction?
    // Navigation and scroll alone never count — the agent must have filled a
    // field or clicked something non-wallet before the pass condition can fire.
    const hasInteracted = observations.some((o) => {
      if (o.isNoop) return false;
      if (o.step.startsWith('fill_input'))  return true;
      if (o.step.startsWith('click_text') &&
          !/connect wallet|sign in|log in/i.test(o.step)) return true;
      return false;
    });

    // For TOKEN_CREATION, keyword matching alone is never enough.
    // The form page always contains the pass-condition keywords (social, handle,
    // fee, sharing, etc.) so we'd stop immediately on every visit.
    // Require either: a fill_input step was done AND the submit button was clicked,
    // OR a transaction was attempted (the API buffer includes a /create endpoint).
    const isTokenCreation = options?.featureType === 'TOKEN_CREATION';
    const hasFilled = observations.some((o) => !o.isNoop && o.step.startsWith('fill_input'));
    const hasSubmitted = observations.some(
      (o) => !o.isNoop && o.step.startsWith('click_text') &&
        /create|launch|deploy|mint|submit|confirm/i.test(o.step),
    );
    const tokenCreationReady = !isTokenCreation || (hasFilled && hasSubmitted);

    const successMessageFound = stepMessages.some(
      (m) => m.type === 'success' && passConditionMet(options?.passCondition ?? '', m.text),
    );
    if (
      options?.passCondition &&
      hasInteracted &&
      tokenCreationReady &&
      (passConditionMet(options.passCondition, textAfter) || successMessageFound)
    ) {
      console.log('[executor] Pass condition appears met — stopping early');
      return { observations, stopReason: 'completed', consecutiveNoops };
    }

    if (
      (blockerDetected === 'auth_required' && inputsAfter.length === 0 && !workflowStructureVisible) ||
      blockerDetected === 'bot_protection'
    ) {
      console.log(`[executor] Hard blocker encountered: ${blockerDetected} — stopping`);
      return { observations, stopReason: 'blocker', consecutiveNoops };
    }

    // Noop threshold: before giving up, try one adaptive LLM decision.
    // This handles cases where the static plan is stuck but the page has
    // actionable content the pattern-based auto-detection missed.
    if (consecutiveNoops >= NOOP_THRESHOLD) {
      if (adaptiveCallCount < MAX_ADAPTIVE && options?.claim && stepsToRun.length === 0) {
        console.log('[executor] Noop threshold — trying adaptive recovery step');
        const adaptive = await decideAdaptiveStep(
          page, options.claim, options.passCondition ?? '', runningNarratives,
          options.investigationWalletAddress, options.featureType,
        ).catch(() => null);
        adaptiveCallCount++;
        if (adaptive) {
          stepsToRun.push(adaptive);
          consecutiveNoops = 0;  // reset noop counter — adaptive gives a fresh chance
          console.log(`[executor] Adaptive recovery step: ${JSON.stringify(adaptive)}`);
          continue;  // re-enter loop with the adaptive step
        }
      }
      console.log('[executor] No-op threshold reached — stopping for replanning');
      return { observations, stopReason: 'noop_threshold', consecutiveNoops };
    }

    if (observations.length >= STEP_BUDGET) {
      console.log(`[executor] Step budget exhausted (${STEP_BUDGET} steps)`);
      return { observations, stopReason: 'budget', consecutiveNoops };
    }
  }

  return { observations, stopReason: 'completed', consecutiveNoops };
}

// ─────────────────────────────────────────────────────────────────────────────
// Build a human-readable result message for an observation
// ─────────────────────────────────────────────────────────────────────────────

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
  }
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

async function performStep(page: Page, step: AgentStep, baseDomain: string, walletAddress?: string): Promise<void> {
  switch (step.action) {

    case 'navigate': {
      const base = baseDomain.replace(/\/$/, '');
      const path = step.path.startsWith('/') ? step.path : `/${step.path}`;
      await page.goto(`${base}${path}`, { waitUntil: 'load', timeout: 12_000 }).catch(() =>
        page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 10_000 }),
      );
      await page.waitForTimeout(1_500);
      await triggerWalletReconnect(page);
      break;
    }

    case 'open_link_text': {
      const href = await page.evaluate((text: string) => {
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        const match   = anchors.find((el) => (el.textContent ?? '').trim().includes(text));
        return match ? (match as HTMLAnchorElement).getAttribute('href') : null;
      }, step.text);

      if (href) {
        const base = baseDomain.replace(/\/$/, '');
        const url  = href.startsWith('http') ? href : `${base}${href.startsWith('/') ? '' : '/'}${href}`;
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
      if (!isSafeToInteract(step.text)) {
        throw new Error(`Blocked by safety filter: "${step.text}"`);
      }

      const isWalletConnect = /connect wallet|connect your wallet|連接錢包|連結錢包/i.test(step.text);

      // Before clicking a submit/create button, auto-inject fake images and
      // mark so we wait longer for the async transaction to come back.
      // Only treat the click as a "submit" action when the button text looks like
      // a final form submission, not a navigation link that also says "Create".
      const isSubmitAction = /^(create token|launch token|deploy token|deploy|mint|submit|create\s+token|launch\s+token)$/i.test(step.text.trim());
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
      if (!isSafeToInteract(text)) throw new Error(`Blocked by safety filter: "${text}"`);

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


