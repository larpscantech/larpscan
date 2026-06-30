/**
 * Direct pump.fun program verification — used when the browser UI cannot
 * complete Privy login but we still need on-chain proof that token creation works.
 */

import { randomBytes } from 'crypto';
import {
  ComputeBudgetProgram,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { PUMP_SDK } from '@pump-fun/pump-sdk';
import {
  investigationConnection,
  investigationKeypair,
  isWalletConfigured,
} from './wallet/client';
import { waitForTxReceiptOutcome } from './wallet/tx-confirm';
import type { TxReceiptOutcome } from './wallet/tx-confirm';

const MEME_PREFIXES = ['Moon', 'Turbo', 'Based', 'Sigma', 'Chad', 'Mega', 'Giga', 'Degen'];
const MEME_SUFFIXES = ['Cat', 'Dog', 'Frog', 'Ape', 'Bird', 'Pepe', 'Hat', 'Coin'];

function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

/** Plausible memecoin name/symbol/uri — no product branding on-chain. */
function generateIncognitoTokenMeta(): { name: string; symbol: string; uri: string } {
  const name   = `${pickRandom(MEME_PREFIXES)} ${pickRandom(MEME_SUFFIXES)}`;
  const symbol = randomBytes(4)
    .toString('base64')
    .replace(/[^A-Z]/gi, '')
    .slice(0, 4)
    .toUpperCase()
    .padEnd(4, 'X');
  const cid    = randomBytes(32).toString('base64url').slice(0, 46);
  const uri    = `https://ipfs.io/ipfs/bafkrei${cid}`;
  return { name, symbol, uri };
}

export function isPumpFunSite(website: string): boolean {
  try {
    const host = new URL(
      website.startsWith('http') ? website : `https://${website}`,
    ).hostname.replace(/^www\./, '');
    return host === 'pump.fun' || host.endsWith('.pump.fun');
  } catch {
    return /pump\.fun/i.test(website);
  }
}

/** Trade / swap claims on pump.fun — use a short observe-only browser path. */
export function isPumpFunTradeClaim(claim: string): boolean {
  return /\b(trade|buy|sell|swap)\b/i.test(claim) &&
    /\b(coin|token|memecoin|listed)\b/i.test(claim);
}

export interface PumpFunCreateResult {
  signature:     string;
  mint:          string;
  receiptStatus: TxReceiptOutcome;
  name:          string;
  symbol:        string;
}

/**
 * Create a minimal test token via the pump.fun program using the investigation wallet.
 * Costs ~0.02 SOL (creation fee + rent + priority fee).
 */
export async function executePumpFunCreateVerification(): Promise<PumpFunCreateResult | null> {
  if (!isWalletConfigured() || !investigationKeypair) return null;

  const { name, symbol, uri } = generateIncognitoTokenMeta();
  const mint = Keypair.generate();

  try {
    const createIx = await PUMP_SDK.createV2Instruction({
      mint:       mint.publicKey,
      name,
      symbol,
      uri,
      creator:    investigationKeypair.publicKey,
      user:       investigationKeypair.publicKey,
      mayhemMode: false,
      cashback:   false,
    });

    const { blockhash } = await investigationConnection.getLatestBlockhash('confirmed');

    const message = new TransactionMessage({
      payerKey:         investigationKeypair.publicKey,
      recentBlockhash:  blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
        createIx,
      ],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([investigationKeypair, mint]);

    const signature = await investigationConnection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries:    3,
    });

    console.log(
      `[pump-onchain] Create tx submitted: ${signature} mint=${mint.publicKey.toBase58()}`,
    );

    const receiptStatus = await waitForTxReceiptOutcome(signature);
    return { signature, mint: mint.publicKey.toBase58(), receiptStatus, name, symbol };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[pump-onchain] Create token failed: ${msg.slice(0, 300)}`);
    return null;
  }
}
