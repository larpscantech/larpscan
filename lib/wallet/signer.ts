/**
 * lib/wallet/signer.ts
 *
 * Server-side signing bridge for the investigation wallet.
 *
 * exposeSigningBridge()  — registers window.larpscanSign on a Playwright
 *                          BrowserContext so the browser-side mock can call it
 *                          to produce real ECDSA signatures via viem.
 *
 * The only signing operations allowed:
 *   personal_sign          — used by Privy/SIWE auth, WalletConnect, dApps
 *   eth_signTypedData_v4   — used by some dApps for EIP-712 messages
 *
 * eth_sendTransaction — forwarded to BSC with a safe gas envelope so complex
 * contract calls (e.g. token factories) are less likely to run out of gas.
 */

import type { BrowserContext } from 'playwright';
import { investigationPublicClient, investigationWalletClient, investigationWalletAddress, investigationAccount } from './client';

// ─── Session Store ────────────────────────────────────────────────────────────
// Encapsulates per-session tx hash and attempt state so concurrent runs never
// bleed into each other (the old flat-Map design caused Rule-0 verdict races).

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

  /** Returns and clears all tx hashes for a session. */
  drainHashes(sessionId: string): string[] {
    const list = this.hashes.get(sessionId) ?? [];
    this.hashes.delete(sessionId);
    return list;
  }

  /** Returns and clears the attempt flag for a session. */
  drainAttempt(sessionId: string): boolean {
    const attempted = this.attempts.get(sessionId) ?? false;
    this.attempts.delete(sessionId);
    return attempted;
  }
}

const sessionStore = new SigningSessionStore();

/** Returns and clears all transaction hashes submitted for a given session. */
export function drainTransactionHashes(sessionId: string): string[] {
  return sessionStore.drainHashes(sessionId);
}

/** Returns and clears whether eth_sendTransaction was attempted for a session. */
export function drainTransactionAttempt(sessionId: string): boolean {
  return sessionStore.drainAttempt(sessionId);
}

/** Returns a BscScan URL for a given tx hash (BSC mainnet). */
export function bscScanTxUrl(hash: string): string {
  return `https://bscscan.com/tx/${hash}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Safety guard — only sign messages that look like auth nonces, not anything
// that resembles a financial operation.
// ─────────────────────────────────────────────────────────────────────────────

const UNSAFE_PATTERNS = [
  /transfer/i,
  /approve/i,
  /spend/i,
  /amount/i,
  /recipient/i,
  /send.*token/i,
  /execute.*swap/i,
  /drainWallet/i,
];

/** Default gas for heavy BSC contract calls; dApp may override via gas / gasLimit (clamped). */
const DEFAULT_TX_GAS = BigInt(3_500_000);
const MIN_TX_GAS     = BigInt(250_000);
const MAX_TX_GAS     = BigInt(12_000_000);

function resolveGasLimit(txParams: Record<string, string | undefined>): bigint {
  const raw = txParams.gas ?? txParams.gasLimit;
  if (raw && /^0x[0-9a-f]+$/i.test(raw)) {
    try {
      const g = BigInt(raw);
      if (g <= BigInt(0)) return DEFAULT_TX_GAS;
      if (g < MIN_TX_GAS) return MIN_TX_GAS;
      if (g > MAX_TX_GAS) return MAX_TX_GAS;
      return g;
    } catch {
      /* fall through */
    }
  }
  return DEFAULT_TX_GAS;
}

function isSafeToSign(rawMessage: string): boolean {
  // Decode hex messages to inspect plaintext
  let decoded = rawMessage;
  if (rawMessage.startsWith('0x')) {
    try {
      decoded = Buffer.from(rawMessage.slice(2), 'hex').toString('utf8');
    } catch { /* keep raw if not valid utf8 */ }
  }
  return !UNSAFE_PATTERNS.some((re) => re.test(decoded));
}

// ─────────────────────────────────────────────────────────────────────────────
// exposeSigningBridge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exposes `window.larpscanSign(method, paramsJson)` in every page of the
 * given Playwright context.  The browser-side window.ethereum mock calls this
 * function for personal_sign requests so Privy / SIWE can authenticate.
 *
 * @returns A cleanup function that logs bridge removal (call on context close).
 */
export async function exposeSigningBridge(context: BrowserContext, sessionId: string): Promise<void> {
  if (!investigationWalletClient || !investigationWalletAddress || !investigationAccount) {
    console.log('[wallet/signer] No wallet configured — signing bridge not installed');
    return;
  }
  // Initialize empty buckets for this session
  sessionStore.init(sessionId);

  // Narrow types after null check
  const walletClient  = investigationWalletClient;
  const walletAddress = investigationWalletAddress;
  const walletAccount = investigationAccount;  // full Account object with private key

  await context.exposeFunction(
    'larpscanSign',
    async (method: string, paramsJson: string): Promise<string> => {
      let params: unknown[];
      try {
        params = JSON.parse(paramsJson) as unknown[];
      } catch {
        throw new Error('[signer] Invalid params JSON');
      }

      console.log(`[wallet/signer] Signing request: ${method}`);

      if (method === 'personal_sign' || method === 'eth_sign') {
        // personal_sign params: [message_hex, address]
        // eth_sign params:      [address, message_hex]
        const msgHex = method === 'personal_sign'
          ? (params[0] as string)
          : (params[1] as string);

        if (!msgHex) throw new Error('[signer] Missing message parameter');

        if (!isSafeToSign(msgHex)) {
          console.warn('[wallet/signer] REFUSED: message contains unsafe financial keywords');
          throw Object.assign(
            new Error('LarpScan: message signing refused — unsafe content detected'),
            { code: 4001 },
          );
        }

        // Sign the raw hex message (Privy sends a nonce as utf-8 → hex)
        // Must pass the full Account object (not just address) so viem can access the private key.
        let signature: string;
        try {
          signature = await walletClient.signMessage({
            account: walletAccount,
            message: { raw: msgHex as `0x${string}` },
          });
        } catch (signErr) {
          console.error('[wallet/signer] signMessage failed:', signErr);
          throw Object.assign(new Error('LarpScan: signing failed'), { code: 4001 });
        }

        console.log(`[wallet/signer] ✓ personal_sign complete → ${signature.slice(0, 20)}...`);
        return signature;
      }

      if (method === 'eth_signTypedData_v4') {
        // params: [address, typedDataJson]
        const typedDataStr = params[1] as string;
        if (!typedDataStr) throw new Error('[signer] Missing typedData parameter');

        let typedData: { domain: unknown; types: unknown; message: unknown; primaryType: string };
        try {
          typedData = JSON.parse(typedDataStr);
        } catch {
          throw new Error('[signer] Invalid typed data JSON');
        }

        if (!isSafeToSign(JSON.stringify(typedData.message))) {
          console.warn('[wallet/signer] REFUSED: typed data contains unsafe content');
          throw Object.assign(
            new Error('LarpScan: typed-data signing refused — unsafe content detected'),
            { code: 4001 },
          );
        }

        // Use signTypedData from the wallet client
        const { domain, types, message, primaryType } = typedData as {
          domain:      Record<string, unknown>;
          types:       Record<string, { name: string; type: string }[]>;
          message:     Record<string, unknown>;
          primaryType: string;
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const signature = await walletClient.signTypedData({
          account:     walletAccount,
          domain:      domain as any,
          types:       types as any,
          message:     message as any,
          primaryType: primaryType as any,
        });

        console.log(`[wallet/signer] eth_signTypedData_v4 complete → ${signature.slice(0, 20)}...`);
        return signature;
      }

      if (method === 'eth_sendTransaction') {
        // Forward the transaction to the real BNB network.
        // With minimal wallet balance this will result in "insufficient funds" or similar,
        // which is acceptable — the site's error message is itself verification evidence.
        let txParams = params[0] as Record<string, string | undefined>;

        // ── Signed social vault factory patch ─────────────────────────────
        // The SignedSocialVaultFactory (0x3fca498...) always reverts on BSC —
        // 0 out of 105+ recent token creations used it successfully.
        // When detected, we replace it with the SimpleVaultFactory (0xfab75Dc...)
        // and rebuild vaultData to route 100% of trading fees to the creator's wallet.
        //
        // Calldata structure (measured from the failing tx):
        //   The vaultData `bytes` parameter is always the last ABI word group.
        //   Its content starts with the signed vault's recipient address (word 0),
        //   offsets (words 1-4), and the handle string at word 6 (offset 192 bytes
        //   from content start = 224 bytes from the length word = 448 hex chars).
        //
        // Algorithm:
        //   1. Replace vault factory address hex in calldata.
        //   2. Find the handle in calldata (try known handles in order).
        //   3. Truncate calldata at the length word position.
        //   4. Append new simple-vault vaultData.
        const rawData = (txParams.data ?? '').toLowerCase();
        const SIGNED_VAULT_HEX = '3fca49851d6e6082630729f9dc4334a4eefe795d';
        const OUR_WALLET_HEX   = investigationWalletAddress?.slice(2).toLowerCase() ?? '';

        // Known handles used by the agent (from HANDLE_FALLBACK_SEQUENCE in constants.ts).
        // The handle hex appears in the ABI-encoded calldata exactly 448 hex chars after
        // the vaultData length word. Try each in order — first match wins.
        const KNOWN_HANDLES = [
          'testuser', 'larpscanbnb', 'testuser2', 'testuser3', 'testuser4',
          'lscantest01', 'lscantest02', 'lscantest03', 'lscantest04', 'lscantest05',
          'verifybot01', 'verifybot02', 'verifybot03',
          'agenttest01', 'agenttest02', 'agenttest03',
          'scantest_x1', 'scantest_x2', 'scantest_x3', 'scantest_x4',
        ];

        let patchApplied = false;
        if (rawData.includes(SIGNED_VAULT_HEX) && OUR_WALLET_HEX) {
          for (const handle of KNOWN_HANDLES) {
            const handleHex = Buffer.from(handle, 'utf8').toString('hex');
            const handlePos = rawData.indexOf(handleHex);
            if (handlePos < 0) continue;

            // length word is 448 hex chars before the handle data word
            const lengthWordStart = handlePos - 448;

            // Validate alignment: ABI words are 64 hex chars (32 bytes), starting at char 10
            // (2 "0x" prefix + 8 selector chars). Check word-boundary:
            const lwAligned = lengthWordStart > 0 && (lengthWordStart - 2) % 64 === 8;
            if (!lwAligned) continue;

            // Build simple vault vaultData:
            //   outer length = 0x80 (128 bytes)
            //   inner array offset = 0x20 (32)
            //   count = 1
            //   wallet address (our investigation wallet)
            //   fee share = 10000 bps (100%)
            const simpleVaultData =
              '0000000000000000000000000000000000000000000000000000000000000080' + // length=128
              '0000000000000000000000000000000000000000000000000000000000000020' + // array offset
              '0000000000000000000000000000000000000000000000000000000000000001' + // count=1
              '000000000000000000000000' + OUR_WALLET_HEX +                       // recipient
              '0000000000000000000000000000000000000000000000000000000000002710'; // 10000 bps

            const patched =
              rawData.replace(SIGNED_VAULT_HEX, 'fab75dc774cb9b38b91749b8833360b46a52345f')
                     .slice(0, lengthWordStart) +
              simpleVaultData;

            txParams = { ...txParams, data: patched };
            patchApplied = true;
            console.log(
              `[wallet/signer] ⚡ Patched: SignedSocialVaultFactory → SimpleVaultFactory, ` +
              `handle="${handle}", vaultData → wallet-based fee sharing (${investigationWalletAddress?.slice(0,10)}... 100%)`,
            );
            break;
          }

          if (!patchApplied) {
            console.log('[wallet/signer] ⚠️  Vault patch: no known handle found in calldata — sending original');
          }
        }
        // ── end patch ──────────────────────────────────────────────────────

        // Mark that a transaction was attempted for this session
        sessionStore.markAttempted(sessionId);

        console.log(`[wallet/signer] eth_sendTransaction to=${txParams.to} value=${txParams.value ?? '0x0'}`);

        // Balance check: allow up to 0.1 BNB in value.
        // Token creation with a dev buy of ~0.5 BNB exceeds this — the agent is
        // instructed to zero out the Dev Buy field first so the tx value only
        // includes the factory fee (typically < 0.01 BNB).
        const valueWei = BigInt(txParams.value ?? '0x0');
        const maxAllowed = BigInt('100000000000000000'); // 0.1 BNB
        if (valueWei > maxAllowed) {
          console.warn(`[wallet/signer] Transaction value ${valueWei} exceeds safety limit — rejecting`);
          throw Object.assign(new Error('LarpScan: transaction value exceeds safety limit'), { code: 4001 });
        }

        try {
          const gasLimit = resolveGasLimit(txParams);
          console.log(`[wallet/signer] Using gas limit: ${gasLimit} (from dApp or default)`);
          // Explicit gas bypasses eth_estimateGas pre-flight when simulation reverts
          // before broadcast; unused gas is refunded on BSC.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hash = await (walletClient as any).sendTransaction({
            account: walletAccount,
            to:      txParams.to as `0x${string}` | undefined,
            value:   valueWei,
            data:    txParams.data as `0x${string}` | undefined,
            gas:     gasLimit,
          });
          sessionStore.pushHash(sessionId, hash as string);
          console.log(`[wallet/signer] ✓ Transaction submitted [session ${sessionId.slice(0,8)}]: ${hash}`);
          return hash;
        } catch (txErr) {
          // Common outcomes: insufficient funds, execution reverted, etc.
          const msg = txErr instanceof Error ? txErr.message : String(txErr);
          console.log(`[wallet/signer] Transaction error (expected): ${msg.slice(0, 120)}`);
          // Re-throw so the site handles its own error UI — the error itself is verification evidence
          throw Object.assign(new Error(msg), { code: -32603 });
        }
      }

      throw Object.assign(
        new Error(`LarpScan: signing method '${method}' not supported by investigation bridge`),
        { code: 4200 },
      );
    },
  );

  console.log(`[wallet/signer] Signing bridge installed for ${investigationWalletAddress}`);
}
