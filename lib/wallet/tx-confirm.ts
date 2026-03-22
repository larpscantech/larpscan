/**
 * Wait for a Solana transaction confirmation after broadcast.
 */

import { investigationConnection } from './client';

export type TxReceiptOutcome = 'success' | 'reverted' | 'timeout';

const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_MS            = 2_000;

export async function waitForTxReceiptOutcome(
  signature: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<TxReceiptOutcome> {
  const started = Date.now();
  while (true) {
    if (Date.now() - started > timeoutMs) {
      console.warn(`[wallet/tx-confirm] Confirmation timeout for ${signature.slice(0, 18)}...`);
      return 'timeout';
    }
    try {
      const status = await investigationConnection.getSignatureStatus(signature, {
        searchTransactionHistory: true,
      });
      const value = status?.value;
      if (value?.confirmationStatus === 'confirmed' || value?.confirmationStatus === 'finalized') {
        return value.err === null ? 'success' : 'reverted';
      }
    } catch (e) {
      console.warn('[wallet/tx-confirm] getSignatureStatus error (will retry):', e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
