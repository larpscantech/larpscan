import type { Page } from 'playwright';
import { capturePageText } from './page-analysis';

/**
 * Fires the injected wallet mock's connection events so the dApp picks up
 * our provider after navigation, modal dismiss, or any state reset.
 *
 * This is the SINGLE source of truth for "poke the wallet mock".
 * Previously this logic was copy-pasted in 4 places with subtle differences
 * (some forgot EIP-6963, some forgot __larpscanTriggerConnect).
 */
export async function triggerWalletReconnect(
  page: Page,
  opts: { withEip6963?: boolean; waitMs?: number } = {},
): Promise<void> {
  const { withEip6963 = true, waitMs = 1_000 } = opts;

  await page.evaluate((fireEip6963: boolean) => {
    const w = window as unknown as Record<string, unknown>;

    const eth = w['ethereum'] as
      | { request?: (a: { method: string; params: unknown[] }) => Promise<unknown> }
      | undefined;
    if (eth && typeof eth.request === 'function') {
      eth.request({ method: 'eth_requestAccounts', params: [] }).catch(() => {});
    }

    if (typeof w['__larpscanTriggerConnect'] === 'function') {
      (w['__larpscanTriggerConnect'] as () => void)();
    }

    if (fireEip6963) {
      window.dispatchEvent(new CustomEvent('eip6963:requestProvider'));
    }
  }, withEip6963).catch(() => {});

  if (waitMs > 0) {
    await page.waitForTimeout(waitMs);
  }
}

/**
 * After clicking a "Connect Wallet" button or during auto-reconnect,
 * try to pick MetaMask or an injected wallet option from any visible
 * wallet picker modal.
 */
export async function tryPickWalletInModal(page: Page): Promise<boolean> {
  const mmBtn = page
    .locator('button, [role="button"], li, div[role="option"]')
    .filter({ hasText: /metamask/i })
    .first();
  const mmVis = await mmBtn.isVisible({ timeout: 2_000 }).catch(() => false);
  if (mmVis) {
    await mmBtn.click().catch(() => {});
    console.log('[wallet-reconnect] Clicked MetaMask in picker');
    await triggerWalletReconnect(page, { waitMs: 3_000 });
    return true;
  }

  const injBtn = page
    .locator('button, [role="button"], li, div[role="option"]')
    .filter({ hasText: /injected|browser wallet|detected/i })
    .first();
  const injVis = await injBtn.isVisible({ timeout: 1_500 }).catch(() => false);
  if (injVis) {
    await injBtn.click().catch(() => {});
    console.log('[wallet-reconnect] Clicked Injected wallet in picker');
    await triggerWalletReconnect(page, { waitMs: 3_000 });
    return true;
  }

  return false;
}

/**
 * Full auto-reconnect flow: fire events, click connect button, pick wallet,
 * then verify success. Returns true if the wallet is now connected.
 */
export async function autoReconnectWallet(
  page: Page,
  walletAddress: string,
): Promise<boolean> {
  await triggerWalletReconnect(page, { waitMs: 2_000 });

  const connectBtnSelectors = [
    page.locator('button, [role="button"], a').filter({ hasText: /connect wallet to continue/i }).first(),
    page.locator('button, [role="button"], a').filter({ hasText: /^connect wallet$/i }).first(),
    page.locator('button, [role="button"], a').filter({ hasText: /^connect$/i }).first(),
    page.locator('button, [role="button"], a').filter({ hasText: /connect wallet/i }).first(),
  ];

  for (const btn of connectBtnSelectors) {
    const vis = await btn.isVisible({ timeout: 1_500 }).catch(() => false);
    if (vis) {
      const txt = (await btn.textContent().catch(() => '') ?? '').trim().slice(0, 60);
      await btn.click().catch(() => {});
      console.log(`[wallet-reconnect] Auto-reconnect: clicked "${txt}"`);
      await page.waitForTimeout(2_000);

      await triggerWalletReconnect(page, { waitMs: 2_000 });
      await tryPickWalletInModal(page);
      break;
    }
  }

  const reconnectText = await capturePageText(page);
  const addrLower = walletAddress.toLowerCase();
  const short = addrLower.slice(0, 6);
  const end = addrLower.slice(-4);
  const textLower = reconnectText.toLowerCase();

  const addrVisible = textLower.includes(short) && textLower.includes(end);
  const connectGone = !/connect wallet to continue|wallet required|please connect your wallet/i.test(reconnectText);
  const hasContent = reconnectText.trim().length > 100;

  const reconnected = addrVisible || (connectGone && hasContent);
  if (reconnected) {
    console.log(`[wallet-reconnect] Auto-reconnect succeeded (addr=${addrVisible}, cta_gone=${connectGone})`);
  } else {
    console.log('[wallet-reconnect] Auto-reconnect did not resolve wallet_required');
  }
  return reconnected;
}
