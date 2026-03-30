import type { Page } from 'playwright';

export interface ReconnectOptions {
  waitMs?: number;
  withEip6963?: boolean;
}

/** Fire Phantom mock connect + optional wait. */
export async function triggerWalletReconnect(
  page: Page,
  opts: ReconnectOptions = {},
): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const sol = w['solana'] as { connect?: () => Promise<unknown> } | undefined;
    if (sol?.connect) sol.connect().catch(() => {});
    if (typeof w['__larpscanTriggerConnect'] === 'function') {
      (w['__larpscanTriggerConnect'] as () => void)();
    }
  }).catch(() => {});
  if (opts.waitMs) await page.waitForTimeout(opts.waitMs);
}

/** Click Phantom (or first wallet) in an open wallet picker modal. */
export async function tryPickWalletInModal(page: Page): Promise<boolean> {
  const clicked = await page.locator('button, [role="button"], li, div[role="option"]')
    .filter({ hasText: /phantom|solflare|backpack/i })
    .first()
    .click({ timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (clicked) await page.waitForTimeout(2_000);
  return clicked;
}

/** Best-effort reconnect when a flow hits wallet_required. */
export async function autoReconnectWallet(
  page: Page,
  _walletAddress: string,
): Promise<boolean> {
  await triggerWalletReconnect(page, { waitMs: 1_500 });
  const picked = await tryPickWalletInModal(page);
  const connected = await page.evaluate(() => {
    const sol = (window as unknown as Record<string, unknown>)['solana'] as
      { isConnected?: boolean; publicKey?: { toString: () => string } } | undefined;
    return Boolean(sol?.isConnected && sol.publicKey);
  }).catch(() => false);
  return picked || connected;
}
