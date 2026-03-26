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

    // Tell Playwright to look in /tmp for all browser binaries.
    const tmpBrowsersPath = '/tmp/playwright-browsers';
    process.env.PLAYWRIGHT_BROWSERS_PATH = tmpBrowsersPath;

    const ffmpegDir    = path.join(tmpBrowsersPath, `ffmpeg-${revision}`);
    const ffmpegTarget = path.join(ffmpegDir, 'ffmpeg-linux');

    if (!fsSync.existsSync(ffmpegTarget)) {
      // ffmpeg-static exports the path to its bundled binary.
      const ffmpegSource = (await import('ffmpeg-static')).default as string;

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

export async function launchChromium(options: LaunchOptions = {}): Promise<Browser> {
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
