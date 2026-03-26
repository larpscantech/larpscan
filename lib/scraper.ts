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

function normalizeUrl(raw: string): string {
  const t = raw.trim();
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
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
          'Mozilla/5.0 (compatible; ChainVerify/1.0; +https://chainverify.io)',
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

async function fetchViaPlaywright(url: string): Promise<string> {
  console.log('[scraper] SPA detected — launching Playwright render...');

  const browser = await launchChromium({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // Navigate and wait for the network to quiet down (JS rendered)
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20_000 });

    // Give any lazy-loaded content an extra moment to paint
    await page.waitForTimeout(1_500);

    const baseOrigin = new URL(url).origin;

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
  const url = normalizeUrl(rawUrl);
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
    } catch (e) {
      console.warn('[scraper] Playwright fallback also failed:', e);
    }
  }

  return text;
}
