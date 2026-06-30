#!/usr/bin/env node
/** Quick check: can we fill + launch on bags.fm after SIWS only? */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

try {
  const envPath = new URL('../.env.local', import.meta.url).pathname;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const { installPrivyMockOnContext, waitForPrivyAppId } = await import('../lib/privy-mock.ts');
const { injectWalletMockIntoContext } = await import('../lib/browser-agent/wallet-connect-flow.ts');
const { exposeSigningBridge } = await import('../lib/wallet/signer.ts');
const { investigationWalletAddress } = await import('../lib/wallet/client.ts');

const sfx = (Date.now() % 10000).toString().padStart(4, '0');
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await exposeSigningBridge(ctx, 'launch-test');
await injectWalletMockIntoContext(ctx, investigationWalletAddress);
await installPrivyMockOnContext(ctx, investigationWalletAddress);
const page = await ctx.newPage();
await page.goto('https://bags.fm/launch', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);
await waitForPrivyAppId(page, 15000);
await page.evaluate(async () => {
  const fn = window['__larpscanPrivySiwsLogin'];
  if (typeof fn === 'function') await fn();
});
await page.waitForTimeout(3000);

await page.locator('input[placeholder="Name"], input').first().fill(`TestToken${sfx}`).catch(() => {});
const inputs = page.locator('input:visible');
const count = await inputs.count();
for (let i = 0; i < count; i++) {
  const ph = await inputs.nth(i).getAttribute('placeholder').catch(() => '');
  if (ph === 'Ticker') await inputs.nth(i).fill(`T${sfx.slice(-3)}`);
}

await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(1000);

const info = await page.evaluate(() => {
  const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
    text: (b.innerText || '').trim(),
    disabled: b.disabled,
  }));
  return { url: location.href, buttons: buttons.filter(b => b.text), body: document.body.innerText.slice(0, 400) };
});

console.log(JSON.stringify(info, null, 2));
const launchBtn = page.locator('button').filter({ hasText: /^launch$/i }).last();
if (await launchBtn.count()) {
  console.log('Launch enabled:', await launchBtn.isEnabled());
  await launchBtn.click().catch((e) => console.log('Launch click error:', e.message));
  await page.waitForTimeout(3000);
  console.log('After launch click:', (await page.evaluate(() => document.body.innerText)).slice(0, 300));
}
await page.screenshot({ path: '/tmp/bags-launch-test.png' });
await browser.close();
