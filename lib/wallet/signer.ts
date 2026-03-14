/**
 * Server-side signing bridge for the Solana investigation wallet.
 *
 * exposeSigningBridge() registers window.larpscanSign on a Playwright context.
 * The browser-side Phantom mock calls it for signMessage / signAndSendTransaction.
 */

import type { BrowserContext } from 'playwright';
import {
  Transaction,
  VersionedTransaction,
  sendAndConfirmRawTransaction,
} from '@solana/web3.js';
import {
  investigationConnection,
  investigationKeypair,
  investigationWalletAddress,
} from './client';
import { solScanTxUrl } from '../solana';

class SigningSessionStore {
  private readonly hashes   = new Map<string, string[]>();
  private readonly attempts = new Map<string, boolean>();

  init(sessionId: string): void {
    this.hashes.set(sessionId, []);
    this.attempts.set(sessionId, false);
  }

  pushHash(sessionId: string, hash: string): void {
    const list = this.hashes.get(sessionId) ?? [];
    list.push(hash);
    this.hashes.set(sessionId, list);
  }

  markAttempted(sessionId: string): void {
    this.attempts.set(sessionId, true);
  }

  drainHashes(sessionId: string): string[] {
    const list = this.hashes.get(sessionId) ?? [];
    this.hashes.delete(sessionId);
    return list;
  }

  drainAttempt(sessionId: string): boolean {
    const attempted = this.attempts.get(sessionId) ?? false;
    this.attempts.delete(sessionId);
    return attempted;
  }
}

const sessionStore = new SigningSessionStore();

export function drainTransactionHashes(sessionId: string): string[] {
  return sessionStore.drainHashes(sessionId);
}

export function drainTransactionAttempt(sessionId: string): boolean {
  return sessionStore.drainAttempt(sessionId);
}

export { solScanTxUrl };

const UNSAFE_PATTERNS = [
  /transfer/i,
  /approve/i,
  /spend/i,
  /amount/i,
  /recipient/i,
  /drainWallet/i,
];

function isSafeToSign(message: string): boolean {
  return !UNSAFE_PATTERNS.some((re) => re.test(message));
}

const MAX_LAMPORTS_PER_TX = 100_000_000; // 0.1 SOL

function deserializeTransaction(serializedBase64: string): Transaction | VersionedTransaction {
  const bytes = Buffer.from(serializedBase64, 'base64');
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch {
    return Transaction.from(bytes);
  }
}

export async function exposeSigningBridge(context: BrowserContext, sessionId: string): Promise<void> {
  if (!investigationKeypair || !investigationWalletAddress) {
    console.log('[wallet/signer] No wallet configured — signing bridge not installed');
    return;
  }

  const keypair = investigationKeypair;
  sessionStore.init(sessionId);

  await context.exposeFunction(
    'larpscanSign',
    async (method: string, paramsJson: string): Promise<string> => {
      let params: unknown;
      try {
        params = JSON.parse(paramsJson);
      } catch {
        throw new Error('[signer] Invalid params JSON');
      }

      console.log(`[wallet/signer] Signing request: ${method}`);

      if (method === 'solana_signMessage') {
        const { message, encoding } = params as { message: string; encoding?: string };
        const decoded =
          encoding === 'hex'
            ? Buffer.from(message.replace(/^0x/, ''), 'hex')
            : Buffer.from(message, encoding === 'base64' ? 'base64' : 'utf8');

        const text = decoded.toString('utf8');
        if (!isSafeToSign(text)) {
          throw Object.assign(new Error('LarpScan: message signing refused'), { code: 4001 });
        }

        const nacl = await import('tweetnacl');
        const sig = nacl.sign.detached(decoded, keypair.secretKey);
        return Buffer.from(sig).toString('base64');
      }

      if (method === 'solana_signTransaction' || method === 'solana_signAndSendTransaction') {
        sessionStore.markAttempted(sessionId);
        const { transaction: serialized } = params as { transaction: string };
        if (!serialized) throw new Error('[signer] Missing transaction');

        const tx = deserializeTransaction(serialized);

        if (tx instanceof VersionedTransaction) {
          tx.sign([keypair]);
          if (method === 'solana_signTransaction') {
            return Buffer.from(tx.serialize()).toString('base64');
          }
          const sig = await investigationConnection.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            maxRetries: 2,
          });
          sessionStore.pushHash(sessionId, sig);
          console.log(`[wallet/signer] ✓ Versioned tx submitted: ${sig}`);
          return sig;
        }

        tx.partialSign(keypair);
        if (method === 'solana_signTransaction') {
          return Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64');
        }

        const sig = await sendAndConfirmRawTransaction(
          investigationConnection,
          tx.serialize(),
          { commitment: 'confirmed' },
        );
        sessionStore.pushHash(sessionId, sig);
        console.log(`[wallet/signer] ✓ Legacy tx confirmed: ${sig}`);
        return sig;
      }

      throw new Error(`[signer] Unsupported method: ${method}`);
    },
  );

  console.log(`[wallet/signer] Solana signing bridge installed for ${investigationWalletAddress}`);
}
