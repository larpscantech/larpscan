/**
 * Balance snapshots for the Solana investigation wallet.
 */

import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { getAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { investigationConnection, investigationWalletAddress } from './client';

export interface TokenBalance {
  address:  string;
  symbol:   string;
  decimals: number;
  raw:      bigint;
}

export interface WalletSnapshot {
  takenAt:       number;
  walletAddress: string;
  nativeLamports: bigint;
  nativeSol:     string;
  tokens:        TokenBalance[];
}

export interface SnapshotDiff {
  nativeDeltaLamports: bigint;
  nativeDeltaSol:      string;
  unexpectedOutflow:   boolean;
  tokenDeltas: { address: string; symbol: string; deltaRaw: bigint; direction: 'in' | 'out' | 'same' }[];
}

export async function takeSnapshot(
  tokenMints: string[] = [],
): Promise<WalletSnapshot | null> {
  const walletAddress = investigationWalletAddress;
  if (!walletAddress) return null;

  const pubkey = new PublicKey(walletAddress);
  const nativeLamports = BigInt(
    await investigationConnection.getBalance(pubkey).catch(() => 0),
  );

  const tokens: TokenBalance[] = [];
  for (const mint of tokenMints) {
    try {
      const mintPk = new PublicKey(mint);
      const ata = PublicKey.findProgramAddressSync(
        [pubkey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintPk.toBuffer()],
        TOKEN_PROGRAM_ID,
      )[0];
      const acct = await getAccount(investigationConnection, ata);
      tokens.push({
        address: mint,
        symbol:  mint.slice(0, 4),
        decimals: 9,
        raw: BigInt(acct.amount.toString()),
      });
    } catch (e) {
      console.warn(`[wallet/snapshots] Failed to read SPL balance for ${mint}:`, e);
    }
  }

  return {
    takenAt: Date.now(),
    walletAddress,
    nativeLamports,
    nativeSol: (Number(nativeLamports) / LAMPORTS_PER_SOL).toFixed(6),
    tokens,
  };
}

export function diffSnapshots(
  before: WalletSnapshot,
  after: WalletSnapshot,
  expectedMaxOutflowLamports: bigint = BigInt(0),
): SnapshotDiff {
  const nativeDeltaLamports = after.nativeLamports - before.nativeLamports;
  const ZERO = BigInt(0);
  const absDelta = nativeDeltaLamports < ZERO ? -nativeDeltaLamports : nativeDeltaLamports;
  const nativeDeltaSol = (Number(absDelta) / LAMPORTS_PER_SOL).toFixed(6);

  const unexpectedOutflow =
    nativeDeltaLamports < ZERO &&
    (-nativeDeltaLamports) > expectedMaxOutflowLamports + BigInt(5_000_000); // +0.005 SOL gas tolerance

  const tokenDeltas = after.tokens.map((afterToken) => {
    const beforeToken = before.tokens.find((t) => t.address === afterToken.address);
    const deltaRaw = afterToken.raw - (beforeToken?.raw ?? ZERO);
    return {
      address:   afterToken.address,
      symbol:    afterToken.symbol,
      deltaRaw,
      direction: deltaRaw > ZERO ? 'in' as const : deltaRaw < ZERO ? 'out' as const : 'same' as const,
    };
  });

  return {
    nativeDeltaLamports,
    nativeDeltaSol: `${nativeDeltaLamports < ZERO ? '-' : '+'}${nativeDeltaSol} SOL`,
    unexpectedOutflow,
    tokenDeltas,
  };
}

export function formatSnapshot(s: WalletSnapshot): string {
  const lines = [
    `Wallet: ${s.walletAddress}`,
    `SOL balance: ${s.nativeSol} SOL (${s.nativeLamports} lamports)`,
  ];
  for (const t of s.tokens) {
    lines.push(`  ${t.symbol}: ${t.raw} (raw)`);
  }
  return lines.join('\n');
}

export function formatDiff(d: SnapshotDiff): string {
  const lines = [`Native delta: ${d.nativeDeltaSol}`];
  if (d.unexpectedOutflow) lines.push('⚠ UNEXPECTED OUTFLOW DETECTED');
  for (const td of d.tokenDeltas) {
    if (td.direction !== 'same') {
      lines.push(`  Token ${td.symbol} (${td.address}): ${td.direction} ${td.deltaRaw}`);
    }
  }
  return lines.join('\n');
}
