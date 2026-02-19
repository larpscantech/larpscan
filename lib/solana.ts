/**
 * Solana RPC helpers — mint validation, SPL metadata, on-chain analysis.
 */

import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';

const rpcUrl =
  process.env.SOLANA_RPC_URL ??
  process.env.HELIUS_RPC_URL ??
  'https://api.mainnet-beta.solana.com';

export const solanaConnection = new Connection(rpcUrl, {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60_000,
});

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidMintAddress(address: string): boolean {
  const trimmed = address.trim();
  if (!BASE58_RE.test(trimmed)) return false;
  try {
    new PublicKey(trimmed);
    return true;
  } catch {
    return false;
  }
}

export async function validateMint(mintAddress: string): Promise<void> {
  if (!isValidMintAddress(mintAddress)) {
    throw new Error('Invalid mint address — must be a base58 Solana public key');
  }
  const mint = new PublicKey(mintAddress.trim());
  const info = await solanaConnection.getAccountInfo(mint);
  if (!info) {
    throw new Error('Mint account not found on Solana mainnet');
  }
  const owner = info.owner.toBase58();
  if (
    owner !== TOKEN_PROGRAM_ID.toBase58() &&
    owner !== TOKEN_2022_PROGRAM_ID.toBase58()
  ) {
    throw new Error('Address is not an SPL token mint');
  }
}

export async function getTokenMetadata(
  mintAddress: string,
): Promise<{ name: string; symbol: string }> {
  const mint = new PublicKey(mintAddress.trim());
  try {
    const mintInfo = await getMint(solanaConnection, mint, undefined, TOKEN_PROGRAM_ID);
    void mintInfo;
  } catch {
    /* Token-2022 or fetch failure — fall through to off-chain sources */
  }

  // Try pump.fun (most meme tokens on Solana)
  try {
    const res = await fetch(
      `https://frontend-api-v3.pump.fun/coins/${mintAddress.trim()}`,
      { next: { revalidate: 300 } },
    );
    if (res.ok) {
      const data = (await res.json()) as { name?: string; symbol?: string };
      if (data.name || data.symbol) {
        return {
          name: data.name?.trim() || 'Unknown Token',
          symbol: data.symbol?.trim() || 'UNKNOWN',
        };
      }
    }
  } catch {
    /* non-fatal */
  }

  // DexScreener fallback
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddress.trim()}`,
      { next: { revalidate: 300 } },
    );
    if (res.ok) {
      const data = (await res.json()) as {
        pairs?: { baseToken?: { name?: string; symbol?: string } }[] | null;
      };
      const base = data.pairs?.[0]?.baseToken;
      if (base?.name || base?.symbol) {
        return {
          name: base.name?.trim() || 'Unknown Token',
          symbol: base.symbol?.trim() || 'UNKNOWN',
        };
      }
    }
  } catch {
    /* non-fatal */
  }

  return { name: 'Unknown Token', symbol: 'UNKNOWN' };
}

// ── On-chain token analysis ───────────────────────────────────────────────────

export interface LiquidityPair {
  pairAddress: string;
  quoteToken:  string;
  quoteSymbol: string;
  reserve0:    string;
  reserve1:    string;
}

export interface OnChainReport {
  address:         string;
  isMint:          boolean;
  name:            string | null;
  symbol:          string | null;
  decimals:        number | null;
  totalSupply:     string | null;
  mintAuthority:   string | null;
  freezeAuthority: string | null;
  solBalance:      string;
  hasLiquidity:    boolean;
  liquidityPairs:  LiquidityPair[];
  isPumpFun:       boolean;
  signals:         string[];
}

export async function analyzeTokenOnChain(mintAddress: string): Promise<OnChainReport> {
  const address = mintAddress.trim();
  const signals: string[] = [];

  if (!isValidMintAddress(address)) {
    return {
      address,
      isMint: false,
      name: null,
      symbol: null,
      decimals: null,
      totalSupply: null,
      mintAuthority: null,
      freezeAuthority: null,
      solBalance: '0',
      hasLiquidity: false,
      liquidityPairs: [],
      isPumpFun: false,
      signals: ['NOT_A_MINT: invalid Solana mint address format'],
    };
  }

  const mint = new PublicKey(address);
  const accountInfo = await solanaConnection.getAccountInfo(mint).catch(() => null);

  if (!accountInfo) {
    return {
      address,
      isMint: false,
      name: null,
      symbol: null,
      decimals: null,
      totalSupply: null,
      mintAuthority: null,
      freezeAuthority: null,
      solBalance: '0',
      hasLiquidity: false,
      liquidityPairs: [],
      isPumpFun: false,
      signals: ['NOT_FOUND: mint account does not exist on Solana mainnet'],
    };
  }

  const owner = accountInfo.owner.toBase58();
  const isSplMint =
    owner === TOKEN_PROGRAM_ID.toBase58() ||
    owner === TOKEN_2022_PROGRAM_ID.toBase58();

  if (!isSplMint) {
    return {
      address,
      isMint: false,
      name: null,
      symbol: null,
      decimals: null,
      totalSupply: null,
      mintAuthority: null,
      freezeAuthority: null,
      solBalance: '0',
      hasLiquidity: false,
      liquidityPairs: [],
      isPumpFun: false,
      signals: [`NOT_SPL_MINT: account owner is ${owner.slice(0, 8)}…`],
    };
  }

  signals.push('MINT_LIVE: valid SPL token mint on Solana mainnet');

  let decimals: number | null = null;
  let totalSupply: string | null = null;
  let mintAuthority: string | null = null;
  let freezeAuthority: string | null = null;

  try {
    const mintInfo = await getMint(solanaConnection, mint);
    decimals = mintInfo.decimals;
    totalSupply = (Number(mintInfo.supply) / 10 ** mintInfo.decimals).toLocaleString();
    mintAuthority = mintInfo.mintAuthority?.toBase58() ?? null;
    freezeAuthority = mintInfo.freezeAuthority?.toBase58() ?? null;

    if (decimals !== null) signals.push(`DECIMALS: ${decimals}`);
    if (totalSupply) signals.push(`TOTAL_SUPPLY: ${totalSupply}`);
    if (mintAuthority) signals.push(`MINT_AUTHORITY: ${mintAuthority}`);
    else signals.push('MINT_AUTHORITY_REVOKED: no mint authority');
    if (freezeAuthority) signals.push(`FREEZE_AUTHORITY: ${freezeAuthority}`);
  } catch (e) {
    signals.push(`MINT_READ_ERROR: ${e instanceof Error ? e.message : 'unknown'}`);
  }

  const meta = await getTokenMetadata(address);
  if (meta.name !== 'Unknown Token') signals.push(`TOKEN_NAME: ${meta.name}`);
  if (meta.symbol !== 'UNKNOWN') signals.push(`TOKEN_SYMBOL: ${meta.symbol}`);

  const solBalance = (
    (accountInfo.lamports ?? 0) / LAMPORTS_PER_SOL
  ).toFixed(6);
  if (accountInfo.lamports > 0) signals.push(`SOL_BALANCE: ${solBalance} SOL`);

  // Liquidity via DexScreener (Raydium/Orca/Meteora pools)
  const liquidityPairs: LiquidityPair[] = [];
  let isPumpFun = false;

  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${address}`,
      { next: { revalidate: 120 } },
    );
    if (res.ok) {
      const data = (await res.json()) as {
        pairs?: {
          pairAddress?: string;
          dexId?: string;
          quoteToken?: { address?: string; symbol?: string };
          liquidity?: { quote?: number };
          volume?: { h24?: number };
        }[] | null;
      };
      for (const pair of data.pairs ?? []) {
        if (!pair.pairAddress) continue;
        if (pair.dexId === 'pumpfun' || pair.dexId === 'pumpswap') isPumpFun = true;
        liquidityPairs.push({
          pairAddress: pair.pairAddress,
          quoteToken:  pair.quoteToken?.address ?? '',
          quoteSymbol: pair.quoteToken?.symbol ?? 'SOL',
          reserve0:    String(pair.liquidity?.quote ?? 0),
          reserve1:    String(pair.volume?.h24 ?? 0),
        });
        signals.push(
          `LIQUIDITY_${pair.quoteToken?.symbol ?? 'SOL'}: ${pair.dexId ?? 'dex'} pair active`,
        );
      }
    }
  } catch {
    /* non-fatal */
  }

  // pump.fun bonding curve check
  if (!isPumpFun) {
    try {
      const pf = await fetch(
        `https://frontend-api-v3.pump.fun/coins/${address}`,
        { next: { revalidate: 300 } },
      );
      if (pf.ok) {
        isPumpFun = true;
        signals.push('PUMP_FUN: token launched on pump.fun');
      }
    } catch {
      /* non-fatal */
    }
  }

  const hasLiquidity = liquidityPairs.length > 0 || isPumpFun;
  if (!hasLiquidity) signals.push('NO_DEX_LIQUIDITY: no Raydium/Orca/pump.fun pool found');

  return {
    address,
    isMint: true,
    name: meta.name !== 'Unknown Token' ? meta.name : null,
    symbol: meta.symbol !== 'UNKNOWN' ? meta.symbol : null,
    decimals,
    totalSupply,
    mintAuthority,
    freezeAuthority,
    solBalance,
    hasLiquidity,
    liquidityPairs,
    isPumpFun,
    signals,
  };
}

/** @deprecated use analyzeTokenOnChain */
export const analyzeContractOnChain = analyzeTokenOnChain;

export function formatOnChainEvidence(report: OnChainReport): string {
  return [
    `On-chain analysis for ${report.address} (Solana):`,
    ...report.signals.map((s) => `  • ${s}`),
  ].join('\n');
}

export function solScanTxUrl(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}

export function solScanAddressUrl(address: string): string {
  return `https://solscan.io/account/${address}`;
}
