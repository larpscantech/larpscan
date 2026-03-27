import path        from 'path';
import fsSync      from 'fs';
import fs          from 'fs/promises';
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
// ensureFFmpegForPlaywright
//
// Playwright's recordVideo requires an ffmpeg binary that it ships separately.
// @sparticuz/chromium only provides Chromium — ffmpeg is absent in serverless
// runtimes.  This function copies the static binary from the `ffmpeg-static`
// npm package (which IS bundled with the deployment) to the exact path
// Playwright expects, then sets PLAYWRIGHT_BROWSERS_PATH so Playwright finds it.
//
// Safe to call multiple times — no-ops once the binary is in place.
// ─────────────────────────────────────────────────────────────────────────────
let _ffmpegReady = false;

export function isFFmpegReady(): boolean { return _ffmpegReady; }

export async function ensureFFmpegForPlaywright(): Promise<void> {
  if (_ffmpegReady) return;

  try {
    // Read the expected ffmpeg revision from playwright-core's manifest.
    let revision = '1011'; // fallback for current playwright
    try {
      const coreDir = path.dirname(require.resolve('playwright-core/package.json'));
      const browsersJson = JSON.parse(
        await fs.readFile(path.join(coreDir, 'browsers.json'), 'utf8'),
      ) as { browsers: Array<{ name: string; revision: string }> };
      revision = browsersJson.browsers?.find(b => b.name === 'ffmpeg')?.revision ?? revision;
    } catch { /* use fallback */ }

    // ffmpeg-static exports the path to its bundled binary.
    // Guard: if the binary doesn't exist in the deployment (e.g. Lambda bundles
    // sometimes omit large native binaries), skip setup rather than crashing.
    const ffmpegSource = (await import('ffmpeg-static')).default as string;
    if (!ffmpegSource || !fsSync.existsSync(ffmpegSource)) {
      console.warn('[browser] ffmpeg-static binary not present at expected path — recording disabled');
      return;
    }

    // Tell Playwright to look in /tmp for all browser binaries.
    // Only set this after confirming ffmpeg source exists so we don't redirect
    // Playwright's browser path when recording is unavailable.
    const tmpBrowsersPath = '/tmp/playwright-browsers';
    process.env.PLAYWRIGHT_BROWSERS_PATH = tmpBrowsersPath;

    const ffmpegDir    = path.join(tmpBrowsersPath, `ffmpeg-${revision}`);
    const ffmpegTarget = path.join(ffmpegDir, 'ffmpeg-linux');

    if (!fsSync.existsSync(ffmpegTarget)) {
      await fs.mkdir(ffmpegDir, { recursive: true });
      await fs.copyFile(ffmpegSource, ffmpegTarget);
      await fs.chmod(ffmpegTarget, 0o755);

      console.log(`[browser] ffmpeg installed → ${ffmpegTarget}`);
    }

    _ffmpegReady = true;
  } catch (e) {
    console.warn('[browser] ffmpeg setup failed (recording disabled):', e);
  }
}

/** Parses PROXY_URL env var into Playwright's proxy config format. */
export function getProxyConfig(): { server: string; username?: string; password?: string } | undefined {
  const raw = process.env.PROXY_URL;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const config: { server: string; username?: string; password?: string } = {
      server: `${url.protocol}//${url.hostname}:${url.port}`,
    };
    if (url.username) config.username = decodeURIComponent(url.username);
    if (url.password) config.password = decodeURIComponent(url.password);
    console.log(`[browser] Proxy configured → ${url.hostname}:${url.port}`);
    return config;
  } catch {
    console.warn(`[browser] Invalid PROXY_URL — ignoring`);
    return undefined;
  }
}

export async function launchChromium(options: LaunchOptions = {}): Promise<Browser> {
  const mergedArgs = mergeArgs(options.args);
  const proxy = getProxyConfig();

  if (isServerlessRuntime()) {
    try {
      const chromium = (await import('@sparticuz/chromium')).default;
      const executablePath = await chromium.executablePath();

      return await playwrightChromium.launch({
        ...options,
        executablePath,
        args: mergeArgs([...(chromium.args ?? []), ...mergedArgs]),
        headless: options.headless ?? true,
        ...(proxy ? { proxy } : {}),
      });
    } catch (error) {
      console.warn('[browser] Falling back to Playwright bundled Chromium:', error);
    }
  }

  return playwrightChromium.launch({
    ...options,
    args: mergedArgs,
    headless: options.headless ?? true,
    ...(proxy ? { proxy } : {}),
  });
}
