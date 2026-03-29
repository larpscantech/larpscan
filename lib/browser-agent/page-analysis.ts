import type { Page } from 'playwright';
import type { AxInteractiveNode, BlockerType, FormInput, PageState } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Verb keywords used to prioritise high-signal route candidates
// ─────────────────────────────────────────────────────────────────────────────

const NAV_VERBS = new Set([
  // English
  'create', 'launch', 'claim', 'swap', 'stake', 'trade', 'mint', 'deploy',
  'dashboard', 'leaderboard', 'explore', 'connect', 'submit', 'earn', 'buy',
  'sell', 'bridge', 'vote', 'farm', 'pool', 'lend', 'borrow', 'market',
  // Traditional Chinese
  '創建', '創造', '啟動', '領取', '兌換', '質押', '交易', '鑄造', '部署',
  '儀表板', '排行榜', '探索', '連接', '連結', '提交', '賺取', '購買',
  '出售', '橋接', '投票', '農場', '池', '借貸', '借出', '市場',
  '鑽探', '挖礦', '開始', '生成', '兌幣', '礦池', '油礦',
]);

function labelHasVerb(label: string): boolean {
  const lower = label.toLowerCase();
  return [...NAV_VERBS].some((v) => lower.includes(v));
}

function scoreRouteCandidate(path: string, label: string, headings: string[], sections: string[]): { score: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];
  if (labelHasVerb(label)) {
    score += 4;
    reasons.push('verb label');
  }
  if (path.split('/').length <= 2) {
    score += 1;
    reasons.push('short path');
  }
  const combined = `${headings.join(' ')} ${sections.join(' ')}`.toLowerCase();
  if (combined.includes(label.toLowerCase()) && label.trim().length > 0) {
    score += 2;
    reasons.push('matches visible sections');
  }
  if (/(leaderboard|dashboard|create|swap|claim|排行榜|儀表板|創建|兌換|領取)/i.test(path + ' ' + label)) {
    score += 3;
    reasons.push('feature route keyword');
  }
  return { score, reason: reasons.join(', ') || 'baseline route' };
}

function scoreCtaCandidate(
  text: string,
  isPrimary: boolean,
  headings: string[],
  sections: string[],
): { score: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];
  if (isPrimary) {
    score += 3;
    reasons.push('primary');
  }
  if (labelHasVerb(text)) {
    score += 2;
    reasons.push('verb cta');
  }
  const combined = `${headings.join(' ')} ${sections.join(' ')}`.toLowerCase();
  if (combined.includes(text.toLowerCase()) && text.trim().length > 0) {
    score += 1;
    reasons.push('adjacent section context');
  }
  return { score, reason: reasons.join(', ') || 'baseline cta' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Blocker detection patterns
// ─────────────────────────────────────────────────────────────────────────────

const BLOCKER_PATTERNS: Array<{ type: BlockerType; patterns: RegExp[] }> = [
  {
    type: 'auth_required',
    patterns: [
      // English — specific phrases first to avoid false positives from partial matches
      /sign in to continue/i, /log in to continue/i, /please sign in/i, /please log in/i,
      /login to continue/i, /create account/i, /sign up to continue/i,
      /create an account to continue/i, /verify your email/i, /email verification required/i,
      /log in or sign up/i,
      // Privy / social auth
      /login with twitter/i, /login with github/i, /login with tiktok/i,
      /login with twitch/i, /login with discord/i, /continue with a wallet/i,
      // General auth
      /sign in/i, /log in/i, /\blogin\b/i,
      // KYC / identity verification
      /complete kyc/i, /kyc required/i, /identity verification/i, /verify your identity/i,
      // Traditional Chinese
      /登入/, /登錄/, /請登入/, /需要登入/, /註冊帳號/,
      /身份驗證/, /完成身份認證/, /實名認證/,
    ],
  },
  {
    type: 'wallet_required',
    patterns: [
      // English
      /connect wallet/i, /connect your wallet/i, /wallet required/i, /wallet not connected/i,
      /please connect/i, /no wallet detected/i, /install a wallet/i,
      // Traditional Chinese
      /連接錢包/, /連結錢包/, /請連接錢包/, /未連接錢包/, /錢包未連接/, /連接您的錢包/,
      /未檢測到錢包/, /安裝錢包/,
    ],
  },
  {
    type: 'coming_soon',
    patterns: [
      // English
      /coming soon/i, /under construction/i, /not available yet/i, /launching soon/i,
      /under maintenance/i, /scheduled maintenance/i, /temporarily unavailable/i,
      /we.?re working on it/i, /check back later/i,
      // Traditional Chinese
      /即將推出/, /敬請期待/, /建設中/, /即將上線/, /功能開發中/,
      /維護中/, /系統維護/, /暫時不可用/,
    ],
  },
  {
    type: 'route_missing',
    patterns: [
      // English
      /\b404\b/, /page not found/i, /this page could not be found/i, /no page found/i,
      /this page doesn.?t exist/i, /nothing to see here/i, /oops.*not found/i,
      // Traditional Chinese
      /頁面不存在/, /找不到頁面/, /頁面未找到/, /此頁面不存在/,
    ],
  },
  {
    type: 'bot_protection',
    patterns: [
      // English — Cloudflare, hCaptcha, reCAPTCHA, generic
      /just a moment/i, /checking your browser/i, /cf-browser-verification/i, /enable javascript/i,
      /verify you are human/i, /are you a robot/i, /complete the captcha/i,
      /solve the challenge/i, /hcaptcha/i, /recaptcha/i,
      /access denied/i, /blocked by.*protection/i,
      // Traditional Chinese
      /正在驗證您的瀏覽器/, /請稍候/, /啟用 JavaScript/, /驗證碼/,
    ],
  },
  {
    type: 'rate_limited',
    patterns: [
      // English
      /too many requests/i, /rate limit/i, /\b429\b/, /slow down/i, /try again later/i,
      /request limit exceeded/i,
      // Traditional Chinese
      /請求過多/, /請求頻率過高/, /操作太頻繁/,
    ],
  },
  {
    type: 'geo_blocked',
    patterns: [
      // English
      /not available in your region/i, /geographic restriction/i, /country not supported/i,
      /unavailable in your location/i, /restricted territory/i, /vpn detected/i,
      /this service is not available/i,
      // Traditional Chinese
      /您所在地區不支援/, /地區限制/, /不支援您的地區/, /此國家不可用/,
    ],
  },
  {
    type: 'empty_state',
    patterns: [
      // English
      /no data/i, /no results/i, /nothing here/i, /no entries/i,
      /no items found/i, /empty/i,
      // Traditional Chinese
      /暫無數據/, /沒有結果/, /沒有數據/, /無記錄/, /暫無記錄/,
    ],
  },
];

function detectBlockers(text: string, bodyLength: number): BlockerType[] {
  const found: BlockerType[] = [];
  if (bodyLength < 20) found.push('page_broken');

  // Weak patterns like "sign in" / "log in" / "connect wallet" appear in
  // nav bars and footers on full product pages. Only flag them as blockers
  // when the visible text is short (< 600 chars), indicating a gate/modal.
  const WEAK_AUTH_PATTERNS = [/\bsign in\b/i, /\blog in\b/i, /\blogin\b/i];
  const WEAK_WALLET_PATTERNS = [/connect wallet/i, /please connect/i];
  const isShort = text.length < 600;

  for (const { type, patterns } of BLOCKER_PATTERNS) {
    const effective = patterns.filter((re) => {
      if (!isShort) {
        if (type === 'auth_required' && WEAK_AUTH_PATTERNS.some((w) => w.source === re.source)) return false;
        if (type === 'wallet_required' && WEAK_WALLET_PATTERNS.some((w) => w.source === re.source)) return false;
      }
      return true;
    });
    if (effective.some((re) => re.test(text))) found.push(type);
  }
  return [...new Set(found)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalize a raw href into a relative path — returns null if should be discarded
// ─────────────────────────────────────────────────────────────────────────────

function normaliseHref(href: string, origin: string): string | null {
  const raw = (href ?? '').trim();
  if (!raw || /^(javascript|mailto|tel|data|#)/i.test(raw)) return null;

  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return null;
  }

  if (url.origin !== origin) return null;

  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path || '/';
}

// ─────────────────────────────────────────────────────────────────────────────
// capturePageText — exported for verifier.ts backward compat
// ─────────────────────────────────────────────────────────────────────────────

export async function capturePageText(page: Page): Promise<string> {
  try {
    const raw = await page.evaluate(() => {
      const clone = document.body.cloneNode(true) as HTMLElement;

      // Remove non-content elements
      clone.querySelectorAll('script,style,noscript,svg,img,video,canvas').forEach((el) => el.remove());

      // Remove Next.js / React error overlays — these render full JS stack traces
      // in the DOM and pollute the page text with "Cannot read properties of
      // undefined" etc., causing the verdict LLM to incorrectly flag the site as broken.
      clone.querySelectorAll([
        'nextjs-portal',                       // Next.js 13+ error overlay host
        '[data-nextjs-dialog]',
        '[data-nextjs-errors]',
        '#__NEXT_DATA_ERRORS__',
        '.__next-error-overlay',
        '.nextjs-container-errors-header',
        '.nextjs-container-errors',
        '[class*="nextjs-toast-errors"]',
        '[id*="__next_error"]',
        '[id*="webpack-dev-server-client-overlay"]',
        'vite-error-overlay',                  // Vite error overlay
        '#vite-error-overlay',
      ].join(',')).forEach((el) => el.remove());

      return (clone as HTMLElement).innerText ?? '';
    });
    return raw.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getInteractiveElements — exported for verifier.ts backward compat
// ─────────────────────────────────────────────────────────────────────────────

export async function getInteractiveElements(
  page: Page,
): Promise<{ tag: string; text: string; href?: string }[]> {
  try {
    return await page.$$eval(
      'button:not([disabled]), [role="button"], a[href], input[type="submit"]',
      (els) =>
        els
          .slice(0, 30)
          .map((el) => ({
            tag:  el.tagName.toLowerCase(),
            text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
            href: el.getAttribute('href') ?? undefined,
          }))
          .filter((e) => e.text.length > 0),
    );
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// analyzePageState — main export
// Collects rich structured DOM state from a live Playwright page.
// Safe to call multiple times within a session (read-only, no side effects).
// ─────────────────────────────────────────────────────────────────────────────

export async function analyzePageState(
  page: Page,
  connectedWalletAddress?: string,
): Promise<PageState> {
  const url   = page.url();
  const title = await page.title().catch(() => '');

  // ── Visible text ──────────────────────────────────────────────────────────
  const visibleText = await capturePageText(page);

  // ── Nav links ─────────────────────────────────────────────────────────────
  const navLinks = await page.$$eval(
    'nav a[href], header a[href]',
    (els) => els.map((el) => ({
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
      href: el.getAttribute('href') ?? undefined,
    })).filter((e) => e.text.length > 0),
  ).catch(() => [] as { text: string; href?: string }[]);

  // ── All links ─────────────────────────────────────────────────────────────
  const allLinks = await page.$$eval(
    'a[href]',
    (els) => els.map((el) => ({
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
      href: el.getAttribute('href') ?? '',
    })).filter((e) => e.text.length > 0 && e.href.length > 0),
  ).catch(() => [] as { text: string; href: string }[]);

  const links = allLinks.map(({ text, href }) => ({ text, href }));

  // ── Route candidates (deduplicated, verb-prioritised, capped at 15) ────────
  const origin = (() => { try { return new URL(url).origin; } catch { return ''; } })();
  const pathMap = new Map<string, string>();
  for (const { text, href } of allLinks) {
    const p = normaliseHref(href, origin);
    if (!p) continue;
    const existing = pathMap.get(p);
    if (!existing || (labelHasVerb(text) && !labelHasVerb(existing)) || text.length > existing.length) {
      pathMap.set(p, text);
    }
  }
  const routeCandidates = [...pathMap.entries()]
    .sort(([pathA, labelA], [pathB, labelB]) => {
      const navSet = new Set(
        navLinks
          .map((n) => n.href ?? '')
          .filter(Boolean)
          .map((href) => normaliseHref(href, origin))
          .filter((p): p is string => !!p),
      );
      const aNav = navSet.has(pathA) ? 0 : 1;
      const bNav = navSet.has(pathB) ? 0 : 1;
      if (aNav !== bNav) return aNav - bNav;
      const aVerb = labelHasVerb(labelA) ? 0 : 1;
      const bVerb = labelHasVerb(labelB) ? 0 : 1;
      if (aVerb !== bVerb) return aVerb - bVerb;
      return pathA.split('/').length - pathB.split('/').length;
    })
    .slice(0, 15)
    .map(([path]) => path);

  // ── Buttons ───────────────────────────────────────────────────────────────
  const buttons = await page.$$eval(
    'button, [role="button"]',
    (els) => els.map((el) => {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
      const isPrimary = (
        el.tagName === 'BUTTON' && (
          (el as HTMLElement).closest('form') !== null ||
          (el as HTMLElement).className.includes('primary') ||
          (el as HTMLElement).className.includes('submit')
        )
      );
      return { text, disabled, isPrimary };
    }).filter((b) => b.text.length > 0),
  ).catch(() => [] as { text: string; disabled: boolean; isPrimary: boolean }[]);

  // ── CTA candidates (hero / top-of-page primary actions) ───────────────────
  const ctaCandidates = await page.evaluate(() => {
    const candidates: { text: string; selector: string; isPrimary: boolean }[] = [];
    const els = document.querySelectorAll('button, [role="button"], a[href], input[type="submit"]');
    let rank = 0;
    for (const el of Array.from(els).slice(0, 50)) {
      const text = ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 60) continue;
      const rect   = el.getBoundingClientRect();
      const inView = rect.top < window.innerHeight && rect.bottom > 0;
      if (!inView) continue;
      const inNav = !!el.closest('nav, header');
      const inFooter = !!el.closest('footer, aside');
      const inMain = !!el.closest('main, section, article, form');
      // Prefer functional controls inside main content, not chrome/navigation.
      if (inFooter) continue;
      if (inNav && !/leaderboard|dashboard|stats|rank|create|launch|claim|swap|排行榜|儀表板|統計|創建|啟動|領取|兌換/i.test(text)) {
        continue;
      }
      const isPrimary = (
        (el as HTMLElement).className.includes('primary') ||
        (el as HTMLElement).className.includes('submit') ||
        el.tagName === 'BUTTON' ||
        (el as HTMLElement).closest('form') !== null
      );
      if (!inMain && !isPrimary) continue;
      // Selector is best-effort and may be used for diagnostics only.
      candidates.push({ text, selector: `button:has-text("${text.slice(0, 30)}")`, isPrimary });
      rank++;
    }
    return candidates;
  }).catch(() => [] as { text: string; selector: string; isPrimary: boolean }[]);

  // ── Forms ─────────────────────────────────────────────────────────────────
  // Detect inputs inside explicit <form> elements
  const formTagForms = await page.$$eval(
    'form',
    (formEls) => formEls.map((form) => {
      const inputs = Array.from(
        form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]), textarea, select'),
      ).map((inp) => {
        const el    = inp as HTMLInputElement;
        const label = (() => {
          const aria = el.getAttribute('aria-label');
          if (aria) return aria.trim();
          const labelledBy = el.getAttribute('aria-labelledby');
          if (labelledBy) {
            const t = labelledBy
              .split(/\s+/)
              .map((id) => (document.getElementById(id)?.textContent ?? '').replace(/\s+/g, ' ').trim())
              .filter(Boolean)
              .join(' ');
            if (t) return t;
          }
          const id = el.id;
          if (id) {
            const lbl = form.querySelector(`label[for="${id}"]`);
            if (lbl) return (lbl.textContent ?? '').trim();
          }
          const parent = el.closest('label');
          if (parent) return (parent.textContent ?? '').replace(el.value, '').trim();
          const prev = el.previousElementSibling;
          if (prev && prev.tagName === 'LABEL') return (prev.textContent ?? '').trim();
          return '';
        })();
        return {
          name:        el.name        || '',
          placeholder: el.placeholder || '',
          type:        el.type        || 'text',
          label:       label.slice(0, 60),
        };
      });
      return { inputs };
    }),
  ).catch(() => [] as { inputs: FormInput[] }[]);

  // Also detect loose inputs outside <form> tags (React-style forms using divs)
  const looseInputs = await page.evaluate((): Array<{ name: string; placeholder: string; type: string; label: string }> => {
    return Array.from(
      document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea'),
    ).filter((el) => !el.closest('form') && (el as HTMLElement).offsetParent !== null)
      .map((el) => {
        const e = el as HTMLInputElement;
        // Try to get a label from sibling/parent elements
        const label = (() => {
          const aria = e.getAttribute('aria-label');
          if (aria) return aria.trim();
          const labelledBy = e.getAttribute('aria-labelledby');
          if (labelledBy) {
            const t = labelledBy
              .split(/\s+/)
              .map((id) => (document.getElementById(id)?.textContent ?? '').replace(/\s+/g, ' ').trim())
              .filter(Boolean)
              .join(' ');
            if (t) return t;
          }
          const id = e.id;
          if (id) {
            const lbl = document.querySelector(`label[for="${id}"]`);
            if (lbl) return (lbl.textContent ?? '').trim();
          }
          const parent = e.closest('label');
          if (parent) return (parent.textContent ?? '').replace(e.value, '').trim();
          const prev = e.previousElementSibling;
          if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'P')) {
            return (prev.textContent ?? '').trim();
          }
          const group = e.closest('div');
          const prevGroup = group?.previousElementSibling;
          if (prevGroup && (prevGroup.tagName === 'LABEL' || prevGroup.tagName === 'P' || prevGroup.tagName === 'SPAN')) {
            return (prevGroup.textContent ?? '').replace(/\s+/g, ' ').trim();
          }
          return '';
        })();
        return {
          name:        e.name        || '',
          placeholder: e.placeholder || '',
          type:        e.type        || (el.tagName === 'TEXTAREA' ? 'textarea' : 'text'),
          label:       label.slice(0, 60) || e.id || '',
        };
      });
  }).catch(() => [] as Array<{ name: string; placeholder: string; type: string; label: string }>);

  // Merge: if no form-tag forms but loose inputs exist, create a synthetic form entry
  const forms: { inputs: FormInput[] }[] = formTagForms.length > 0
    ? formTagForms
    : looseInputs.length > 0
      ? [{ inputs: looseInputs }]
      : [];

  // ── Headings ─────────────────────────────────────────────────────────────
  const headings = await page.$$eval(
    'h1, h2, h3, h4',
    (els) => els.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 20),
  ).catch(() => [] as string[]);

  // ── Section labels ────────────────────────────────────────────────────────
  const sectionLabels = await page.$$eval(
    'section > h1, section > h2, section > h3, article > h1, article > h2, [class*="card"] h1, [class*="card"] h2, [class*="card"] h3',
    (els) => els.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 15),
  ).catch(() => [] as string[]);

  // ── Ranked route/cta metadata (deterministic-first hints) ────────────────
  const rankedRoutes = [...pathMap.entries()]
    .map(([path, label]) => {
      const scored = scoreRouteCandidate(path, label, headings, sectionLabels);
      return { path, score: scored.score, reason: scored.reason };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  const rankedCtas = ctaCandidates
    .map((c) => {
      const scored = scoreCtaCandidate(c.text, c.isPrimary, headings, sectionLabels);
      return { text: c.text, selector: c.selector, score: scored.score, reason: scored.reason };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  // ── Table headers ─────────────────────────────────────────────────────────
  // Detect both real <table> headers AND common CSS-grid/div-based leaderboards.
  const nativeTableHeaders = await page.$$eval(
    'table th, [role="table"] [role="columnheader"], thead td',
    (els) => els.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 20),
  ).catch(() => [] as string[]);

  // Fallback: detect div/CSS-grid row-based tables (many crypto dashboards use these).
  // We look for a cluster of elements that collectively look like column headers:
  // a horizontally-arranged set of short text nodes inside a grid/flex container
  // that precedes rows of similar-width children.
  const divTableHeaders = nativeTableHeaders.length > 0 ? [] : await page.evaluate(() => {
    const HEADER_LIKE = /(#|name|rank|earn|fee|market|cap|price|token|wallet|user|amount|volume|total|perf|score|hash|ticket|status|address|date|time|reward)/i;

    // Look for elements whose direct children all contain short text and look like column labels
    const candidates = Array.from(document.querySelectorAll(
      '[class*="header"] [class*="col"], [class*="header"] [class*="cell"], ' +
      '[class*="row"]:first-child > *, [class*="thead"] *, ' +
      '[class*="leaderboard"] [class*="header"] *, [class*="table"] [class*="header"] *, ' +
      '[class*="grid"] [class*="header"] *, [class*="list"] [class*="header"] *',
    ));

    const texts = candidates
      .map((el) => ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter((t) => t.length > 0 && t.length < 40 && HEADER_LIKE.test(t));

    if (texts.length >= 2) return texts.slice(0, 10);

    // Last resort: look for a compact row that has 3+ short siblings and the text
    // matches column-header vocabulary (e.g. "#, Name, Earnings, Price")
    const allEls = Array.from(document.querySelectorAll('span, div, td, th, p'));
    const seen = new Set<string>();
    const colHeaderRow: string[] = [];
    for (const el of allEls) {
      const t = ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t.length > 0 && t.length < 30 && HEADER_LIKE.test(t) && !seen.has(t)) {
        // Check siblings
        const parent = el.parentElement;
        if (!parent) continue;
        const sibCount = parent.children.length;
        if (sibCount >= 3) {
          seen.add(t);
          colHeaderRow.push(t);
          if (colHeaderRow.length >= 6) break;
        }
      }
    }
    return colHeaderRow.length >= 2 ? colHeaderRow : [];
  }).catch(() => [] as string[]);

  const tableHeaders = nativeTableHeaders.length > 0
    ? nativeTableHeaders
    : divTableHeaders;

  // ── Chart signals ─────────────────────────────────────────────────────────
  const chartSignals = await page.$$eval(
    'canvas ~ *, [class*="chart"] *, [class*="graph"] *, [class*="recharts"] text',
    (els) => els
      .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter((t) => t.length > 1 && t.length < 60)
      .slice(0, 10),
  ).catch(() => [] as string[]);

  // ── Disabled controls ─────────────────────────────────────────────────────
  const disabledControls = await page.$$eval(
    'button[disabled], input[disabled], [aria-disabled="true"]',
    (els) => els.map((el) => (el.textContent ?? el.getAttribute('placeholder') ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 10),
  ).catch(() => [] as string[]);

  // ── Modal detection ───────────────────────────────────────────────────────
  const hasModal = await page.evaluate(() => {
    const dialogs = document.querySelectorAll('dialog, [role="dialog"]');
    for (const d of Array.from(dialogs)) {
      const style = window.getComputedStyle(d);
      if (style.display !== 'none' && style.visibility !== 'hidden') return true;
    }
    return false;
  }).catch(() => false);

  // ── ARIA-enriched interactive elements ────────────────────────────────────
  // Query the DOM for interactive elements and collect their ARIA attributes.
  // This gives us role, accessible name, disabled/required states — much more
  // reliable than plain innerText scraping for identifying what can be clicked.
  const axInteractive: AxInteractiveNode[] = await page.$$eval(
    [
      'button', 'input:not([type="hidden"])', 'select', 'textarea',
      'a[href]', '[role="button"]', '[role="textbox"]', '[role="combobox"]',
      '[role="listbox"]', '[role="checkbox"]', '[role="radio"]',
      '[role="switch"]', '[role="tab"]', '[role="menuitem"]',
    ].join(','),
    (els: Element[]) => {
      const seen = new Set<string>();
      const result: {
        role: string; name: string; disabled: boolean; required: boolean;
        value?: string; expanded?: boolean; checked?: boolean | 'mixed';
      }[] = [];

      for (const el of els) {
        const htmlEl = el as HTMLElement & { disabled?: boolean; required?: boolean; value?: string; checked?: boolean };
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        // Compute accessible name: aria-label > aria-labelledby > label > placeholder > text
        let name = '';
        const ariaLabel = el.getAttribute('aria-label');
        const labelledBy = el.getAttribute('aria-labelledby');
        if (ariaLabel) {
          name = ariaLabel.trim();
        } else if (labelledBy) {
          const labelEl = document.getElementById(labelledBy);
          name = (labelEl?.textContent ?? '').trim();
        } else if ((el as HTMLInputElement).placeholder) {
          name = (el as HTMLInputElement).placeholder;
        } else {
          name = htmlEl.innerText?.trim() ?? el.textContent?.trim() ?? '';
        }
        name = name.slice(0, 80);
        if (!name) continue;

        // Compute role
        const explicitRole = el.getAttribute('role')?.toLowerCase() ?? '';
        const tagRole: Record<string, string> = {
          button: 'button', a: 'link', input: 'textbox', textarea: 'textbox',
          select: 'combobox',
        };
        const role = explicitRole || tagRole[el.tagName.toLowerCase()] || el.tagName.toLowerCase();

        const key = `${role}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const disabled = !!(htmlEl.disabled || el.getAttribute('aria-disabled') === 'true');
        const required = !!(htmlEl.required || el.getAttribute('aria-required') === 'true');
        const value    = htmlEl.value ? String(htmlEl.value).slice(0, 60) : undefined;
        const expanded = el.getAttribute('aria-expanded') === 'true' ? true
                       : el.getAttribute('aria-expanded') === 'false' ? false
                       : undefined;
        const checkedAttr = el.getAttribute('aria-checked');
        const checked: boolean | 'mixed' | undefined =
          checkedAttr === 'true' ? true : checkedAttr === 'false' ? false :
          checkedAttr === 'mixed' ? 'mixed' : (htmlEl.checked ?? undefined);

        result.push({ role, name, disabled, required, value, expanded, checked });
        if (result.length >= 40) break;
      }
      return result;
    },
  ).catch(() => [] as AxInteractiveNode[]);

  // ── Blocker detection ─────────────────────────────────────────────────────
  let blockers = detectBlockers(visibleText, visibleText.length);

  // If the wallet address is already visible in the DOM (navbar shows "0x1b..."),
  // the site considers the wallet connected — suppress the wallet_required blocker
  // so the planner doesn't waste steps trying to re-connect.
  if (connectedWalletAddress && blockers.includes('wallet_required')) {
    const short = connectedWalletAddress.slice(0, 6).toLowerCase();
    const end   = connectedWalletAddress.slice(-4).toLowerCase();
    if (visibleText.toLowerCase().includes(short) || visibleText.toLowerCase().includes(end)) {
      blockers = blockers.filter((b) => b !== 'wallet_required');
    }
  }

  return {
    url,
    title,
    visibleText,
    navLinks,
    links,
    routeCandidates,
    ctaCandidates,
    buttons,
    forms,
    headings,
    sectionLabels,
    tableHeaders,
    chartSignals,
    disabledControls,
    blockers,
    hasModal,
    apiSignals:   [],  // populated by the caller when run-level tracking is available
    axInteractive,
    rankedRoutes,
    rankedCtas,
  };
}
