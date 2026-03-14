/**
 * Solana investigation wallet — server-side signing for browser automation.
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const rpcUrl =
  process.env.SOLANA_RPC_URL ??
  process.env.HELIUS_RPC_URL ??
  'https://api.mainnet-beta.solana.com';

export const investigationConnection = new Connection(rpcUrl, {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60_000,
});

function resolveInvestigationKeypair(): Keypair | null {
  const raw = process.env.INVESTIGATION_WALLET_PRIVATE_KEY?.trim();
  if (!raw) return null;
  try {
    if (raw.startsWith('[')) {
      const arr = JSON.parse(raw) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch (e) {
    console.warn('[wallet/client] INVESTIGATION_WALLET_PRIVATE_KEY invalid — wallet disabled:', e);
    return null;
  }
}

export const investigationKeypair: Keypair | null = resolveInvestigationKeypair();

export const investigationWalletAddress: string | null =
  investigationKeypair?.publicKey.toBase58() ?? null;

export function isWalletConfigured(): boolean {
  return investigationKeypair !== null;
}

export function getInvestigationPublicKey(): PublicKey | null {
  return investigationKeypair?.publicKey ?? null;
}

if (investigationWalletAddress) {
  console.log(`[wallet/client] Investigation wallet ready: ${investigationWalletAddress}`);
} else {
  console.log('[wallet/client] No investigation wallet configured — wallet-gated verification disabled');
}
