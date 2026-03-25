/**
 * lib/wallet/request-classifier.ts
 *
 * Classifies intercepted wallet requests before the policy layer decides
 * whether to allow or reject them.
 *
 * Used by the browser executor to evaluate wallet popup actions.
 */

import type { Address } from 'viem';
import type { WalletActionType } from './policy';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WalletRequestContext {
  /** Raw action classification */
  actionType:           WalletActionType;
  /** Target address (to field for transactions, spender for approvals) */
  toAddress?:           Address;
  /** BNB value being sent (in ether units, e.g. 0.001) */
  valueEther?:          number;
  /** For token approvals — raw bigint amount */
  approvalAmount?:      bigint;
  /** Decoded function signature if recognizable (e.g. 'approve', 'createToken') */
  methodSignature?:     string;
  /** Raw call data hex if available */
  calldata?:            string;
  /** The chain ID requested (should be 56 for BSC) */
  requestedChainId?:    number;
  /** Whether the request matches what the current workflow stage expects */
  isExpected:           boolean;
  /** Human-readable reason why it's expected or unexpected */
  expectedReason:       string;
  /** A short plain-English description for evidence */
  description:          string;
  /** Severity classification */
  severity:             'safe' | 'caution' | 'suspicious' | 'blocked';
}

export interface InterceptedWalletPopup {
  /** Raw popup type from the wallet UI or page */
  popupType:     'connect' | 'sign_message' | 'sign_typed' | 'transaction' | 'switch_chain' | 'unknown';
  /** Raw text visible in the popup */
  visibleText?:  string;
  /** Origin URL of the page triggering the request */
  originUrl?:    string;
  /** Any structured data extracted from the popup */
  rawData?:      Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Known method selectors (first 4 bytes of keccak256 of signature)
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN_SELECTORS: Record<string, string> = {
  '0x095ea7b3': 'approve(address,uint256)',
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0x70a08231': 'balanceOf(address)',
  '0xd0e30db0': 'deposit()',
  '0x2e1a7d4d': 'withdraw(uint256)',
  // BSC common launchpad signatures
  '0x1249c58b': 'mint()',
  '0x40c10f19': 'mint(address,uint256)',
  '0xa0712d68': 'mint(uint256)',
  '0x4e71d92d': 'claim()',
  '0x379607f5': 'claim(uint256)',
};

function decodeSelector(calldata: string | undefined): string | undefined {
  if (!calldata || calldata.length < 10) return undefined;
  const selector = calldata.slice(0, 10).toLowerCase();
  return KNOWN_SELECTORS[selector] ?? `unknown_selector(${selector})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Approval amount helpers
// ─────────────────────────────────────────────────────────────────────────────

const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

function isUnlimitedApproval(amount: bigint): boolean {
  return amount >= MAX_UINT256 / BigInt(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// classifyWalletRequest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classifies an intercepted wallet popup into a typed `WalletRequestContext`.
 *
 * @param popup         Intercepted popup data
 * @param claimFeature  The feature type being verified (e.g. 'TOKEN_CREATION')
 * @param workflowStage Current agent workflow stage
 */
export function classifyWalletRequest(
  popup:          InterceptedWalletPopup,
  claimFeature:   string = '',
  workflowStage:  string = '',
): WalletRequestContext {
  // ── connect request ───────────────────────────────────────────────────────
  if (popup.popupType === 'connect') {
    return {
      actionType:       'connect',
      isExpected:       true,
      expectedReason:   'Wallet connection expected for any gated workflow',
      description:      'Site requests wallet connection',
      severity:         'safe',
    };
  }

  // ── switch chain ─────────────────────────────────────────────────────────
  if (popup.popupType === 'switch_chain') {
    const chainId = (popup.rawData?.chainId as number) ?? 0;
    const isBSC   = chainId === 56 || chainId === 0x38;
    return {
      actionType:         'contract_interaction',
      requestedChainId:   chainId,
      isExpected:         isBSC,
      expectedReason:     isBSC ? 'Switching to BSC mainnet as expected' : `Unexpected chain switch to ${chainId}`,
      description:        `Switch chain request to chain ID ${chainId}`,
      severity:           isBSC ? 'safe' : 'suspicious',
    };
  }

  // ── message signing ───────────────────────────────────────────────────────
  if (popup.popupType === 'sign_message') {
    const text = popup.visibleText ?? '';
    const isLoginNonce =
      /nonce|sign.*in|login|verify.*wallet|authenticate/i.test(text);
    return {
      actionType:    'message_sign',
      isExpected:    isLoginNonce,
      expectedReason: isLoginNonce
        ? 'Login nonce signing expected for auth-gated features'
        : 'Unexpected message signing request',
      description:   `Sign message: "${text.slice(0, 100)}"`,
      severity:      isLoginNonce ? 'caution' : 'suspicious',
    };
  }

  // ── typed data signing (EIP-712) ──────────────────────────────────────────
  if (popup.popupType === 'sign_typed') {
    return {
      actionType:    'typed_data_sign',
      isExpected:    false,
      expectedReason: 'EIP-712 typed-data signing not expected in basic workflow verification',
      description:   'EIP-712 typed-data signature request',
      severity:      'caution',
    };
  }

  // ── transaction request ───────────────────────────────────────────────────
  if (popup.popupType === 'transaction') {
    const rawData      = popup.rawData ?? {};
    const toAddress    = (rawData.to as Address | undefined);
    const valueHex     = rawData.value as string | undefined;
    const calldata     = rawData.data as string | undefined;

    const valueWei     = valueHex ? BigInt(valueHex) : BigInt(0);
    const valueEther   = Number(valueWei) / 1e18;
    const methodSig    = decodeSelector(calldata);

    // Detect unlimited approval
    if (methodSig?.startsWith('approve')) {
      const amountHex  = calldata?.slice(74) ?? '';
      const amount     = amountHex ? BigInt(`0x${amountHex}`) : BigInt(0);
      const unlimited  = isUnlimitedApproval(amount);
      return {
        actionType:      'token_approval',
        toAddress,
        approvalAmount:  amount,
        methodSignature: methodSig,
        calldata,
        isExpected:      false,
        expectedReason:  unlimited
          ? 'Unlimited approval — automatically flagged as suspicious'
          : 'Token approval not expected in default workflow',
        description:     unlimited
          ? `⚠ UNLIMITED token approval requested for ${toAddress}`
          : `Token approval of ${amount} requested for ${toAddress}`,
        severity:        unlimited ? 'suspicious' : 'caution',
      };
    }

    // Token transfer
    if (methodSig?.startsWith('transfer')) {
      return {
        actionType:      'native_transfer',
        toAddress,
        valueEther,
        methodSignature: methodSig,
        calldata,
        isExpected:      false,
        expectedReason:  'Token transfer not expected in workflow verification',
        description:     `Token transfer to ${toAddress}`,
        severity:        'caution',
      };
    }

    // General contract interaction
    const isExpectedForFeature =
      claimFeature === 'TOKEN_CREATION' ||
      claimFeature === 'DEX_SWAP' ||
      claimFeature === 'WALLET_FLOW';

    return {
      actionType:      'contract_interaction',
      toAddress,
      valueEther,
      methodSignature: methodSig,
      calldata,
      isExpected:      isExpectedForFeature,
      expectedReason:  isExpectedForFeature
        ? `Contract interaction expected for ${claimFeature} flow`
        : `Unexpected contract interaction for ${claimFeature} claim`,
      description:     `Contract call to ${toAddress ?? 'unknown'} value=${valueEther} BNB method=${methodSig ?? 'unknown'}`,
      severity:        valueEther > 0.05 ? 'suspicious' : 'caution',
    };
  }

  // ── unknown ───────────────────────────────────────────────────────────────
  return {
    actionType:    'contract_interaction',
    isExpected:    false,
    expectedReason: 'Unknown wallet request type',
    description:   `Unknown wallet popup: ${popup.popupType}`,
    severity:      'suspicious',
  };
}

/** Short severity label for evidence display */
export function severityLabel(ctx: WalletRequestContext): string {
  const icons: Record<WalletRequestContext['severity'], string> = {
    safe:       '✓',
    caution:    '⚠',
    suspicious: '🚨',
    blocked:    '✗',
  };
  return `${icons[ctx.severity]} [${ctx.severity.toUpperCase()}] ${ctx.description}`;
}
