/**
 * lib/wallet/policy.ts
 *
 * Typed wallet execution policy for the investigation wallet.
 *
 * Every wallet action must pass policy evaluation before proceeding.
 * No wallet action is permitted without an explicit policy check.
 *
 * Policy controls:
 *   - max BNB spend per verification run
 *   - max token approval amount (0 = approvals disabled)
 *   - allowlisted contract addresses (empty = all allowed within value limits)
 *   - whether to allow message signing (personal_sign / eth_sign)
 *   - whether to allow EIP-712 typed-data signing
 *   - whether to allow native token transfers
 *   - whether to allow token approval transactions
 *   - whether to allow general contract interactions
 *   - per-step dry-run guard (log only, never send)
 */

import { parseEther, formatEther } from 'viem';
import type { Address } from 'viem';

// ─────────────────────────────────────────────────────────────────────────────
// Policy definition
// ─────────────────────────────────────────────────────────────────────────────

export interface WalletPolicy {
  /** Max BNB (in ether units) the wallet may spend in one verification run */
  maxNativeSpendEther: number;
  /** Max token amount that can be approved (0 disables approvals entirely) */
  maxApprovalAmount:   bigint;
  /**
   * Optional allowlist of contract addresses the wallet may interact with.
   * Empty array = any address is allowed (within other limits).
   */
  contractAllowlist:   Address[];
  /** Allow personal_sign / eth_sign (message signing) */
  allowMessageSigning: boolean;
  /** Allow EIP-712 typed-data signing */
  allowTypedDataSigning: boolean;
  /** Allow sending native BNB transfers */
  allowNativeTransfers: boolean;
  /** Allow ERC-20 approve() calls */
  allowApprovals:       boolean;
  /** Allow general contract write calls (non-approval, non-transfer) */
  allowContractInteraction: boolean;
  /** Dry-run mode: evaluate policy but never actually broadcast transactions */
  dryRun:               boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default investigation policy — deliberately conservative
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_WALLET_POLICY: WalletPolicy = {
  maxNativeSpendEther:      0.005,           // max 0.005 BNB per run (~$2 at $400/BNB)
  maxApprovalAmount:        BigInt(0),              // approvals disabled by default
  contractAllowlist:        [],              // unrestricted within value limits
  allowMessageSigning:      false,           // off by default — opt-in per claim type
  allowTypedDataSigning:    false,
  allowNativeTransfers:     true,            // small transfers allowed (e.g. token creation fee)
  allowApprovals:           false,
  allowContractInteraction: true,            // write calls allowed if value ≤ maxNativeSpend
  dryRun:                   false,
};

/** Policy used during creation-flow verification — allows small fee sends */
export const TOKEN_CREATION_POLICY: WalletPolicy = {
  ...DEFAULT_WALLET_POLICY,
  maxNativeSpendEther:      0.01,
  allowNativeTransfers:     true,
  allowContractInteraction: true,
};

/** Safest policy for exploratory runs — evaluate only, never send */
export const DRY_RUN_POLICY: WalletPolicy = {
  ...DEFAULT_WALLET_POLICY,
  dryRun:                   true,
  allowMessageSigning:      false,
  allowTypedDataSigning:    false,
  allowNativeTransfers:     false,
  allowApprovals:           false,
  allowContractInteraction: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Policy evaluation
// ─────────────────────────────────────────────────────────────────────────────

export interface PolicyDecision {
  allowed:  boolean;
  reason:   string;
  dryRun:   boolean;
}

export interface PolicyEvaluationInput {
  actionType:          WalletActionType;
  toAddress?:          Address;
  valueEther?:         number;    // BNB value
  approvalAmount?:     bigint;
  totalSpentThisRunEther: number; // cumulative BNB spend so far
}

export type WalletActionType =
  | 'connect'
  | 'message_sign'
  | 'typed_data_sign'
  | 'native_transfer'
  | 'token_approval'
  | 'contract_interaction';

export function evaluatePolicy(
  input: PolicyEvaluationInput,
  policy: WalletPolicy,
): PolicyDecision {
  const { actionType, toAddress, valueEther = 0, approvalAmount, totalSpentThisRunEther } = input;

  if (policy.dryRun) {
    return { allowed: false, reason: 'Policy: dry-run mode — no transactions broadcast', dryRun: true };
  }

  switch (actionType) {
    case 'connect':
      return { allowed: true, reason: 'Wallet connection always permitted', dryRun: false };

    case 'message_sign':
      if (!policy.allowMessageSigning) {
        return { allowed: false, reason: 'Policy: message signing disabled', dryRun: false };
      }
      return { allowed: true, reason: 'Message signing permitted by policy', dryRun: false };

    case 'typed_data_sign':
      if (!policy.allowTypedDataSigning) {
        return { allowed: false, reason: 'Policy: EIP-712 typed-data signing disabled', dryRun: false };
      }
      return { allowed: true, reason: 'Typed-data signing permitted by policy', dryRun: false };

    case 'native_transfer': {
      if (!policy.allowNativeTransfers) {
        return { allowed: false, reason: 'Policy: native transfers disabled', dryRun: false };
      }
      const projectedTotal = totalSpentThisRunEther + valueEther;
      if (projectedTotal > policy.maxNativeSpendEther) {
        return {
          allowed: false,
          reason: `Policy: spend limit exceeded — projected ${projectedTotal.toFixed(6)} BNB > limit ${policy.maxNativeSpendEther} BNB`,
          dryRun: false,
        };
      }
      if (toAddress && policy.contractAllowlist.length > 0 && !policy.contractAllowlist.includes(toAddress)) {
        return { allowed: false, reason: `Policy: destination ${toAddress} not in contract allowlist`, dryRun: false };
      }
      return { allowed: true, reason: `Native transfer of ${valueEther} BNB permitted`, dryRun: false };
    }

    case 'token_approval': {
      if (!policy.allowApprovals) {
        return { allowed: false, reason: 'Policy: token approvals disabled', dryRun: false };
      }
      if (policy.maxApprovalAmount === BigInt(0)) {
        return { allowed: false, reason: 'Policy: max approval amount is 0', dryRun: false };
      }
      if (approvalAmount !== undefined && approvalAmount > policy.maxApprovalAmount) {
        return {
          allowed: false,
          reason: `Policy: approval amount ${approvalAmount} exceeds max ${policy.maxApprovalAmount}`,
          dryRun: false,
        };
      }
      return { allowed: true, reason: 'Token approval permitted within policy limits', dryRun: false };
    }

    case 'contract_interaction': {
      if (!policy.allowContractInteraction) {
        return { allowed: false, reason: 'Policy: contract interactions disabled', dryRun: false };
      }
      const projectedTotal = totalSpentThisRunEther + valueEther;
      if (projectedTotal > policy.maxNativeSpendEther) {
        return {
          allowed: false,
          reason: `Policy: spend limit exceeded — projected ${projectedTotal.toFixed(6)} BNB > limit ${policy.maxNativeSpendEther} BNB`,
          dryRun: false,
        };
      }
      if (toAddress && policy.contractAllowlist.length > 0 && !policy.contractAllowlist.includes(toAddress)) {
        return { allowed: false, reason: `Policy: target ${toAddress} not in contract allowlist`, dryRun: false };
      }
      return { allowed: true, reason: 'Contract interaction permitted by policy', dryRun: false };
    }

    default:
      return { allowed: false, reason: `Policy: unknown action type '${actionType as string}'`, dryRun: false };
  }
}

/** Select the most appropriate policy for a given feature type */
export function policyForFeatureType(featureType: string): WalletPolicy {
  switch (featureType) {
    case 'TOKEN_CREATION': return TOKEN_CREATION_POLICY;
    default:               return DEFAULT_WALLET_POLICY;
  }
}

/** Human-readable spend summary */
export function formatSpend(ether: number): string {
  return `${ether.toFixed(6)} BNB`;
}
