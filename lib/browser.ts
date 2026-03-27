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
// Uses `connectOverCDP` with the `/stealth` path.  CDP mode is required for
// the `Browserless.startRecording` / `Browserless.stopRecording` CDP commands
// that produce WebM screen recordings (requires Prototyping plan or higher).
//
// Built-in residential proxy is configured via query params so Privy and
// other datacenter-IP-blocking services work out of the box.
//
// Falls back to local Playwright launch when BROWSERLESS_TOKEN is absent.
// ─────────────────────────────────────────────────────────────────────────────

function getBrowserlessEndpoint(opts?: { record?: boolean }): string | undefined {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) return undefined;

  const params = new URLSearchParams({ token });

  params.set('proxy', 'residential');
  params.set('proxyCountry', 'us');
  params.set('proxySticky', 'true');

  if (opts?.record) {
    params.set('record', 'true');
    params.set('headless', 'false');
  }

  const region = process.env.BROWSERLESS_REGION ?? 'production-sfo';
  return `wss://${region}.browserless.io/stealth?${params.toString()}`;
}

export async function connectBrowser(opts?: { record?: boolean }): Promise<Browser> {
  const wsEndpoint = getBrowserlessEndpoint(opts);

  if (wsEndpoint) {
    console.log(`[browser] Connecting to Browserless (CDP, record=${opts?.record ?? false})`);
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

export function isFFmpegReady(): boolean { return isBrowserlessMode(); }
export async function ensureFFmpegForPlaywright(): Promise<void> { /* no-op */ }
