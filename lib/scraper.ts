import { parse } from 'node-html-parser';
import { launchChromium } from './browser';

// Tags stripped before extracting text (valid for both fetch + Playwright paths)
// NOTE: nav is stripped from TEXT extraction but nav links are captured first
// via extractNavSection before stripping occurs.
const STRIP_TAGS = [
  'script', 'style', 'noscript', 'svg', 'img',
  'nav', 'footer', 'aside', 'iframe', 'canvas', 'video', 'audio',
];

// If a plain fetch yields fewer chars than this, assume the site is a JS SPA
// and fall back to Playwright to render it first.
const SPA_THRESHOLD = 500;

// Maximum characters passed to the LLM (text content only — nav section is separate)
const MAX_CHARS = 8_000;

// Maximum nav entries included in the nav section
const MAX_NAV_ENTRIES = 15;

// Verb keywords used to prioritise high-signal nav labels
const NAV_VERBS = new Set([
  'create', 'launch', 'claim', 'swap', 'stake', 'trade', 'mint', 'deploy',
  'dashboard', 'leaderboard', 'explore', 'connect', 'submit', 'earn', 'buy',
  'sell', 'bridge', 'vote', 'govern', 'farm', 'pool', 'lend', 'borrow',
]);

// Known URL-shortener / redirect-wrapper hostnames whose landing page content
// is useless — we must follow them to get the real destination.
const SHORT_LINK_HOSTS = new Set([
  't.co', 'bit.ly', 'tinyurl.com', 'ow.ly', 'buff.ly', 'rebrand.ly',
  'short.io', 'cutt.ly', 'rb.gy', 'lnkd.in', 'linktr.ee', 'beacons.ai',
]);

function normalizeUrl(raw: string): string {
  const t = raw.trim();
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

/** Follow HTTP redirect chain and return the final destination URL.
 *  Falls back to the original URL on any error. */
async function resolveRedirects(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });
      const final = res.url;
      if (final && final !== url) {
        console.log(`[scraper] Redirect resolved: ${url} → ${final}`);
      }
      return final || url;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return url;
  }
}

function isShortLink(url: string): boolean {
  try {
    return SHORT_LINK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function extractFromHtml(html: string): string {
  const root = parse(html);
  for (const tag of STRIP_TAGS) {
    root.querySelectorAll(tag).forEach((el) => el.remove());
  }
  return (root.textContent ?? '')
    .replace(/\t/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_CHARS);
}

// ── Nav link extraction helpers ───────────────────────────────────────────────

interface RawLink { text: string; href: string; tier: 1 | 2 }

/**
 * Normalise a raw href into a clean relative path.
 * Returns null if the href should be discarded.
 */
function normaliseHref(href: string, baseOrigin: string): string | null {
  const raw = (href ?? '').trim();
  if (!raw) return null;

  // Discard non-navigable schemes
  if (/^(javascript|mailto|tel|data|#)/i.test(raw)) return null;

  // Fragment-only anchors
  if (raw === '#' || raw.startsWith('#')) return null;

  let url: URL;
  try {
    url = new URL(raw, baseOrigin);
  } catch {
    // Relative path like /swap — prefix with baseOrigin to parse
    try {
      url = new URL(raw.startsWith('/') ? raw : `/${raw}`, baseOrigin);
    } catch {
      return null;
    }
  }

  // Discard external domains
  if (url.origin !== baseOrigin) return null;

  // Build clean path — strip fragment and query string
  let path = url.pathname;

  // Strip trailing slash except root
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  return path || '/';
}

function labelContainsVerb(label: string): boolean {
  const lower = label.toLowerCase();
  return [...NAV_VERBS].some((v) => lower.includes(v));
}

/**
 * Builds the `--- Navigation paths ---` section from raw link candidates.
 * Normalises hrefs, deduplicates by path (keeping best label), caps at MAX_NAV_ENTRIES.
 */
function buildNavSection(raw: RawLink[], baseOrigin: string): string {
  // Normalise and tag each link with its cleaned path
  const normalised = raw
    .map((l) => ({
      path:  normaliseHref(l.href, baseOrigin),
      label: (l.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
      tier:  l.tier,
    }))
    .filter((l): l is { path: string; label: string; tier: 1 | 2 } =>
      l.path !== null && l.label.length > 0,
    );

  // Deduplicate by path — keep the most descriptive label
  const byPath = new Map<string, { label: string; tier: 1 | 2 }>();
  for (const link of normalised) {
    const existing = byPath.get(link.path);
    if (!existing) {
      byPath.set(link.path, { label: link.label, tier: link.tier });
    } else {
      // Prefer: verb label > longer label > existing
      const newHasVerb = labelContainsVerb(link.label);
      const oldHasVerb = labelContainsVerb(existing.label);
      if (newHasVerb && !oldHasVerb) {
        byPath.set(link.path, { label: link.label, tier: link.tier });
      } else if (!newHasVerb && !oldHasVerb && link.label.length > existing.label.length) {
        byPath.set(link.path, { label: link.label, tier: link.tier });
      }
      // Keep lower tier number (tier 1 = nav/header, more valuable)
      if (link.tier < existing.tier) {
        byPath.set(link.path, { ...byPath.get(link.path)!, tier: link.tier });
      }
    }
  }

  // Sort: tier 1 first, then verb-labels, then by path depth (shorter = closer to root)
  const sorted = [...byPath.entries()].sort(([pathA, a], [pathB, b]) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const aVerb = labelContainsVerb(a.label) ? 0 : 1;
    const bVerb = labelContainsVerb(b.label) ? 0 : 1;
    if (aVerb !== bVerb) return aVerb - bVerb;
    return pathA.split('/').length - pathB.split('/').length;
  });

  const capped = sorted.slice(0, MAX_NAV_ENTRIES);

  if (capped.length === 0) return '';

  const lines = capped.map(([p, { label }]) => `${p} → ${label}`);
  return `\n\n--- Navigation paths (verified hrefs) ---\n${lines.join('\n')}`;
}

// ── Strategy 1: plain fetch (fast, works for SSR / static sites) ─────────────

async function fetchViaHttp(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; LarpScan/1.0; +https://larpscan.sh)',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const root       = parse(html);
    const baseOrigin = new URL(url).origin;

    // Extract nav links BEFORE stripping nav/header tags
    const primaryEls  = root.querySelectorAll('nav a[href], header a[href]');
    const primaryLinks: RawLink[] = primaryEls.map((el) => ({
      text: el.text,
      href: el.getAttribute('href') ?? '',
      tier: 1 as const,
    }));

    let allLinks = primaryLinks;

    // Fallback to main a[href] if primary yields fewer than 3
    if (primaryLinks.length < 3) {
      const secondaryEls   = root.querySelectorAll('main a[href]');
      const secondaryLinks: RawLink[] = secondaryEls.map((el) => ({
        text: el.text,
        href: el.getAttribute('href') ?? '',
        tier: 2 as const,
      }));
      allLinks = [...primaryLinks, ...secondaryLinks];
    }

    const navSection = buildNavSection(allLinks.slice(0, 30), baseOrigin);

    const text = extractFromHtml(html);
    console.log(`[scraper] HTTP: ${text.length} chars, ${navSection ? 'nav section appended' : 'no nav links found'}`);
    return text + navSection;
  } finally {
    clearTimeout(timer);
  }
}

// ── Strategy 2: Playwright render (for SPAs / React / Next / Vue apps) ───────

async function fetchViaPlaywright(url: string, mobile = false, gotoTimeout = 25_000): Promise<string> {
  console.log(`[scraper] SPA detected — launching Playwright render${mobile ? ' (mobile UA)' : ''}...`);

  const browser = await launchChromium({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent: mobile
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ...(mobile ? { viewport: { width: 390, height: 844 } } : {}),
    });
    const page = await context.newPage();

    // Use 'domcontentloaded' so pages with continuous rAF animation loops
    // (or long-running background fetches) don't stall the scrape forever.
    // We add an extra wait after load to let JS-rendered content paint.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: gotoTimeout });

    // Wait for either a known JS-framework mount signal or a fixed time cap
    await Promise.race([
      page.waitForFunction(
        () => document.querySelectorAll('[data-reactroot],[id="__next"],#app,#root,[data-v-app]').length > 0,
        { timeout: 6_000 },
      ).catch(() => null),
      page.waitForTimeout(4_000),
    ]);

    // Use the actual loaded URL (after any JS/meta redirects) as the base
    // so nav links from the final destination are not discarded as external.
    const finalUrl   = page.url();
    const baseOrigin = new URL(finalUrl || url).origin;

    // Extract nav links from live DOM BEFORE grabbing full HTML
    const primaryLinks: RawLink[] = await page.$$eval(
      'nav a[href], header a[href]',
      (els) => els.map((el) => ({
        text: (el as HTMLAnchorElement).innerText?.trim() ?? el.textContent?.trim() ?? '',
        href: (el as HTMLAnchorElement).getAttribute('href') ?? '',
        tier: 1 as 1 | 2,
      })),
    ).catch(() => []);

    let allLinks: RawLink[] = primaryLinks;

    // Fallback to main a[href] if primary yields fewer than 3
    if (primaryLinks.length < 3) {
      const secondaryLinks: RawLink[] = await page.$$eval(
        'main a[href]',
        (els) => els.map((el) => ({
          text: (el as HTMLAnchorElement).innerText?.trim() ?? el.textContent?.trim() ?? '',
          href: (el as HTMLAnchorElement).getAttribute('href') ?? '',
          tier: 2 as 1 | 2,
        })),
      ).catch(() => []);
      allLinks = [...primaryLinks, ...secondaryLinks];
    }

    const navSection = buildNavSection(allLinks.slice(0, 30), baseOrigin);

    // Grab the fully-rendered HTML
    const html = await page.content();
    const text = extractFromHtml(html);
    console.log(`[scraper] Playwright: ${text.length} chars, ${navSection ? 'nav section appended' : 'no nav links found'}`);
    return text + navSection;
  } finally {
    await browser.close();
  }
}

/**
 * Fetches a website and returns clean readable text for LLM processing.
 * Appends a `--- Navigation paths ---` section with real internal hrefs
 * so the LLM can use accurate paths instead of guessing.
 *
 * Flow:
 *  1. Try a fast plain HTTP fetch first.
 *  2. If the result is below SPA_THRESHOLD (site is JS-rendered), re-fetch
 *     using a headless Playwright browser that executes the JavaScript.
 */
export async function fetchWebsiteText(rawUrl: string): Promise<string> {
  const normalized = normalizeUrl(rawUrl);

  // Always resolve redirect chains for known short-link hosts;
  // also resolve for any URL to catch unexpected wrapping.
  const url = isShortLink(normalized)
    ? await resolveRedirects(normalized)
    : normalized;

  if (url !== normalized) {
    console.log(`[scraper] Using resolved URL: ${url}`);
  }
  console.log(`[scraper] Fetching ${url}`);

  // ── Step 1: plain fetch ───────────────────────────────────────────────────
  let text: string;
  try {
    text = await fetchViaHttp(url);
    console.log(`[scraper] HTTP fetch → ${text.length} chars (inc. nav section)`);
  } catch (e) {
    console.warn('[scraper] HTTP fetch failed, falling back to Playwright:', e);
    return fetchViaPlaywright(url);
  }

  // ── Step 2: SPA fallback ──────────────────────────────────────────────────
  // Compare only the text portion (before any nav section) against threshold
  const textOnly = text.split('\n\n--- Navigation paths')[0];
  if (textOnly.length < SPA_THRESHOLD) {
    console.log(
      `[scraper] Only ${textOnly.length} chars from HTTP — SPA likely. Switching to Playwright.`,
    );
    try {
      const rendered = await fetchViaPlaywright(url);
      const renderedTextOnly = rendered.split('\n\n--- Navigation paths')[0];
      if (renderedTextOnly.length > textOnly.length) return rendered;
      // Playwright ran but returned equally empty content — try mobile UA fallback
      console.warn(`[scraper] Playwright returned no more content than HTTP (${renderedTextOnly.length} chars) — trying mobile user-agent`);
      const mobile = await fetchViaPlaywright(url, /* mobile */ true, /* timeout */ 15_000);
      const mobileTextOnly = mobile.split('\n\n--- Navigation paths')[0];
      if (mobileTextOnly.length > textOnly.length) {
        console.log(`[scraper] Mobile UA fallback succeeded: ${mobileTextOnly.length} chars`);
        return mobile;
      }
      console.warn(`[scraper] Mobile UA also returned no more content — site likely blocks all headless browsers`);
    } catch (e) {
      console.warn('[scraper] Playwright fallback failed:', (e as Error)?.message ?? e);
    }
  }

  // If both strategies yielded too little content, throw so the API route can
  // return a clear 422 rather than silently returning an empty string.
  if (text.length < 50) {
    throw new Error(
      `Could not extract meaningful content from ${url} — ` +
      `both HTTP fetch (${textOnly.length} chars) and Playwright returned too little text. ` +
      `The site may require authentication, block headless browsers, or have bot protection enabled.`,
    );
  }

  return text;
}
