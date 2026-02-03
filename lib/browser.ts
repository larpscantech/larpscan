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

    // Retry on 429 (Browserless rate limit / capacity).
    // With 3 claims running concurrently and a plan that allows ~2 sessions,
    // the 3rd claim will get 429. Retries with increasing back-off — the longest
    // running claim (DATA_DASHBOARD fast path) takes 30–70s, so by the 3rd or 4th
    // retry the slot should have freed up.
    const MAX_RETRIES = 10;
    const RETRY_DELAYS = [5, 10, 15, 20, 30, 45, 60, 60, 60, 60].map(s => s * 1_000);
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Guard against Browserless accepting the TCP connection but stalling
        // the CDP handshake indefinitely (not a 429, just silent hang).
        // 60s is generous — normal connect takes 3-10s.
        const browser = await Promise.race([
          playwrightChromium.connectOverCDP(wsEndpoint),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('CDP connect timed out (60s)')), 60_000),
          ),
        ]);
        return browser;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const is429 = msg.includes('429') || msg.toLowerCase().includes('too many requests');
        const isTimeout = msg.includes('CDP connect timed out');
        if ((is429 || isTimeout) && attempt < MAX_RETRIES) {
          const waitMs = RETRY_DELAYS[attempt] ?? 60_000;
          console.warn(`[browser] Browserless ${isTimeout ? 'connect-timeout' : '429'} — retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        throw e;
      }
    }
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

