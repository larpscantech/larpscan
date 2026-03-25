/**
 * lib/wallet/client.ts
 *
 * Viem public + wallet clients for BNB mainnet using NodeReal RPC.
 *
 * publicClient  — read-only, used for balance checks, tx confirmations, receipt polling
 * walletClient  — signs/sends transactions; only created when INVESTIGATION_WALLET_PRIVATE_KEY is set
 *
 * Both clients target BSC mainnet (chain ID 56).
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  isHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';
import type { WalletClient, PublicClient, Account, Address } from 'viem';

const rpcUrl = process.env.NODEREAL_RPC ?? 'https://bsc-dataseed.binance.org/';

// ─────────────────────────────────────────────────────────────────────────────
// Public client — always available
// ─────────────────────────────────────────────────────────────────────────────

export const investigationPublicClient: PublicClient = createPublicClient({
  chain: bsc,
  transport: http(rpcUrl, { timeout: 20_000 }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Investigation wallet account — derived from env private key
// ─────────────────────────────────────────────────────────────────────────────

function resolveInvestigationAccount(): Account | null {
  const raw = process.env.INVESTIGATION_WALLET_PRIVATE_KEY?.trim();
  if (!raw) return null;
  const key = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!isHex(key) || key.length !== 66) {
    console.warn('[wallet/client] INVESTIGATION_WALLET_PRIVATE_KEY has invalid format — wallet disabled');
    return null;
  }
  try {
    return privateKeyToAccount(key as `0x${string}`);
  } catch (e) {
    console.warn('[wallet/client] Failed to derive investigation account:', e);
    return null;
  }
}

export const investigationAccount: Account | null = resolveInvestigationAccount();

// ─────────────────────────────────────────────────────────────────────────────
// Wallet client — only created when a valid private key is configured
// ─────────────────────────────────────────────────────────────────────────────

export const investigationWalletClient: WalletClient | null = investigationAccount
  ? createWalletClient({
      account: investigationAccount,
      chain:   bsc,
      transport: http(rpcUrl, { timeout: 30_000 }),
    })
  : null;

export const investigationWalletAddress: Address | null =
  (investigationAccount?.address as Address) ?? null;

export function isWalletConfigured(): boolean {
  return investigationWalletClient !== null;
}

if (investigationWalletAddress) {
  console.log(`[wallet/client] Investigation wallet ready: ${investigationWalletAddress}`);
} else {
  console.log('[wallet/client] No investigation wallet configured — wallet-gated verification disabled');
}
