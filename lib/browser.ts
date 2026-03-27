import { chromium as playwrightChromium, type Browser, type LaunchOptions } from 'playwright';

const DEFAULT_BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
];

function mergeArgs(args: string[] = []): string[] {
  return [...new Set([...DEFAULT_BROWSER_ARGS, ...args])];
}

export function isServerlessRuntime(): boolean {
  return Boolean(
    process.env.VERCEL ||
    process.env.AWS_REGION ||
    process.env.AWS_LAMBDA_FUNCTION_NAME,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Browserless connection
//
// When BROWSERLESS_TOKEN is set, connect to Browserless.io's hosted browser
// instead of launching a local Chromium.  This eliminates the need for
// @sparticuz/chromium, ffmpeg-static, and all the Lambda binary juggling.
//
// Falls back to local Playwright launch when the token is absent (local dev).
// ─────────────────────────────────────────────────────────────────────────────

function getBrowserlessEndpoint(opts?: { record?: boolean; stealth?: boolean }): string | undefined {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) return undefined;

  const params = new URLSearchParams({ token });

  // Residential proxy — bypasses Privy datacenter IP blocking
  params.set('proxy', 'residential');
  params.set('proxyCountry', 'us');
  params.set('proxySticky', 'true');

  if (opts?.record) {
    params.set('record', 'true');
    params.set('headless', 'false');
  }

  const basePath = opts?.stealth ? '/chromium/stealth' : '/chromium';
  const region = process.env.BROWSERLESS_REGION ?? 'production-sfo';
  return `wss://${region}.browserless.io${basePath}?${params.toString()}`;
}

export async function connectBrowser(opts?: { record?: boolean }): Promise<Browser> {
  const wsEndpoint = getBrowserlessEndpoint({ record: opts?.record, stealth: opts?.record });

  if (wsEndpoint) {
    console.log(`[browser] Connecting to Browserless (record=${opts?.record ?? false})`);
    const browser = await playwrightChromium.connectOverCDP(wsEndpoint);
    return browser;
  }

  return launchLocal();
}

// ─────────────────────────────────────────────────────────────────────────────
// Local fallback (dev / testing)
// ─────────────────────────────────────────────────────────────────────────────

async function launchLocal(options: LaunchOptions = {}): Promise<Browser> {
  const mergedArgs = mergeArgs(options.args);

  if (isServerlessRuntime()) {
    try {
      const chromium = (await import('@sparticuz/chromium')).default;
      const executablePath = await chromium.executablePath();

      return await playwrightChromium.launch({
        ...options,
        executablePath,
        args: mergeArgs([...(chromium.args ?? []), ...mergedArgs]),
        headless: options.headless ?? true,
      });
    } catch (error) {
      console.warn('[browser] Falling back to Playwright bundled Chromium:', error);
    }
  }

  return playwrightChromium.launch({
    ...options,
    args: mergedArgs,
    headless: options.headless ?? true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy exports kept for backward compatibility during migration
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Use connectBrowser() instead */
export async function launchChromium(options: LaunchOptions = {}): Promise<Browser> {
  return connectBrowser();
}

export function isBrowserlessMode(): boolean {
  return Boolean(process.env.BROWSERLESS_TOKEN);
}

// ffmpeg helpers are no longer needed with Browserless but kept as no-ops
// so existing callers don't break during migration.
export function isFFmpegReady(): boolean { return isBrowserlessMode(); }
export async function ensureFFmpegForPlaywright(): Promise<void> { /* no-op */ }
