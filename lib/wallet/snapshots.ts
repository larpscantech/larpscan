/**
 * lib/wallet/snapshots.ts
 *
 * Balance snapshots for the investigation wallet.
 *
 * takeSnapshot()   — reads native BNB balance + optional ERC-20 token balances
 * diffSnapshots()  — computes delta between two snapshots
 */

import { formatEther, parseAbi } from 'viem';
import type { Address } from 'viem';
import { investigationPublicClient, investigationWalletAddress } from './client';

const ERC20_BALANCE_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenBalance {
  address:  Address;
  symbol:   string;
  decimals: number;
  raw:      bigint;
}

export interface WalletSnapshot {
  takenAt:      number;           // unix ms
  walletAddress: Address;
  nativeWei:    bigint;
  nativeEther:  string;           // formatted for readability
  tokens:       TokenBalance[];
}

export interface SnapshotDiff {
  nativeDeltaWei:   bigint;
  nativeDeltaEther: string;
  unexpectedOutflow: boolean;     // native balance decreased more than expected
  tokenDeltas:       { address: Address; symbol: string; deltaRaw: bigint; direction: 'in' | 'out' | 'same' }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// takeSnapshot
// ─────────────────────────────────────────────────────────────────────────────

export async function takeSnapshot(
  tokenAddresses: Address[] = [],
): Promise<WalletSnapshot | null> {
  const walletAddress = investigationWalletAddress;
  if (!walletAddress) {
    console.warn('[wallet/snapshots] No investigation wallet — snapshot skipped');
    return null;
  }

  const nativeWei = await investigationPublicClient
    .getBalance({ address: walletAddress })
    .catch(() => BigInt(0));

  const tokens: TokenBalance[] = [];

  for (const tokenAddr of tokenAddresses) {
    try {
      const [rawBalance, decimals, symbol] = await Promise.all([
        investigationPublicClient.readContract({
          address: tokenAddr, abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf', args: [walletAddress],
        }) as Promise<bigint>,
        investigationPublicClient.readContract({
          address: tokenAddr, abi: ERC20_BALANCE_ABI,
          functionName: 'decimals',
        }).catch(() => 18) as Promise<number>,
        investigationPublicClient.readContract({
          address: tokenAddr, abi: ERC20_BALANCE_ABI,
          functionName: 'symbol',
        }).catch(() => '???') as Promise<string>,
      ]);

      tokens.push({ address: tokenAddr, symbol, decimals, raw: rawBalance });
    } catch (e) {
      console.warn(`[wallet/snapshots] Failed to read balance for ${tokenAddr}:`, e);
    }
  }

  return {
    takenAt:      Date.now(),
    walletAddress,
    nativeWei,
    nativeEther:  formatEther(nativeWei),
    tokens,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// diffSnapshots
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param expectedMaxOutflowWei  Optional: how much native outflow is expected
 *                               (e.g. gas + call value). Outflows above this
 *                               are flagged as unexpected.
 */
export function diffSnapshots(
  before:                WalletSnapshot,
  after:                 WalletSnapshot,
  expectedMaxOutflowWei: bigint = BigInt(0),
): SnapshotDiff {
  const nativeDeltaWei   = after.nativeWei - before.nativeWei;   // negative = outflow
  const ZERO = BigInt(0);
  const nativeDeltaEther = formatEther(nativeDeltaWei < ZERO ? -nativeDeltaWei : nativeDeltaWei);

  // Flag unexpected outflow: balance dropped more than expected
  const unexpectedOutflow =
    nativeDeltaWei < ZERO &&
    (-nativeDeltaWei) > expectedMaxOutflowWei + BigInt(5e15); // +0.005 BNB tolerance for gas

  const tokenDeltas = after.tokens.map((afterToken) => {
    const beforeToken = before.tokens.find((t) => t.address === afterToken.address);
    const deltaRaw    = afterToken.raw - (beforeToken?.raw ?? ZERO);
    return {
      address:   afterToken.address,
      symbol:    afterToken.symbol,
      deltaRaw,
      direction: deltaRaw > ZERO ? 'in' : deltaRaw < ZERO ? 'out' : 'same',
    } as SnapshotDiff['tokenDeltas'][number];
  });

  return {
    nativeDeltaWei,
    nativeDeltaEther: `${nativeDeltaWei < ZERO ? '-' : '+'}${nativeDeltaEther} BNB`,
    unexpectedOutflow,
    tokenDeltas,
  };
}

/** Summarise a snapshot for logging / evidence */
export function formatSnapshot(s: WalletSnapshot): string {
  const lines = [
    `Wallet: ${s.walletAddress}`,
    `BNB balance: ${s.nativeEther} BNB (${s.nativeWei} wei)`,
  ];
  for (const t of s.tokens) {
    lines.push(`  ${t.symbol}: ${t.raw} (raw)`);
  }
  return lines.join('\n');
}

/** Summarise a diff for evidence */
export function formatDiff(d: SnapshotDiff): string {
  const lines = [`Native delta: ${d.nativeDeltaEther}`];
  if (d.unexpectedOutflow) lines.push('⚠ UNEXPECTED OUTFLOW DETECTED');
  for (const td of d.tokenDeltas) {
    if (td.direction !== 'same') {
      lines.push(`  Token ${td.symbol} (${td.address}): ${td.direction} ${td.deltaRaw}`);
    }
  }
  return lines.join('\n');
}
