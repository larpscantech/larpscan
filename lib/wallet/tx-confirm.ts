/**
 * Wait for a BSC mainnet transaction receipt after broadcast.
 * Used after Playwright returns so we do not block eth_sendTransaction in the signing bridge.
 */

import { investigationPublicClient } from './client';

export type TxReceiptOutcome = 'success' | 'reverted' | 'timeout';

const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_MS            = 2_000;

/**
 * Polls until the tx is mined or timeout. Reverted txs still get a receipt (status reverted).
 */
export async function waitForTxReceiptOutcome(
  hash: `0x${string}`,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<TxReceiptOutcome> {
  const started = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - started > timeoutMs) {
      console.warn(`[wallet/tx-confirm] Receipt wait timeout for ${hash.slice(0, 18)}...`);
      return 'timeout';
    }
    try {
      const receipt = await investigationPublicClient.getTransactionReceipt({ hash });
      if (receipt) {
        const ok = receipt.status === 'success';
        console.log(
          `[wallet/tx-confirm] Receipt for ${hash.slice(0, 10)}... → status=${receipt.status} gasUsed=${receipt.gasUsed}`,
        );
        return ok ? 'success' : 'reverted';
      }
    } catch (e) {
      console.warn('[wallet/tx-confirm] getTransactionReceipt error (will retry):', e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
