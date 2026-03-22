/**
 * Wallet execution policy for the Solana investigation wallet.
 */

export interface WalletPolicy {
  /** Max SOL the wallet may spend in one verification run */
  maxNativeSpendSol: number;
  /** Optional allowlist of program IDs (empty = any within value limits) */
  programAllowlist: string[];
  allowMessageSigning: boolean;
  allowNativeTransfers: boolean;
  allowProgramInteraction: boolean;
  dryRun: boolean;
}

export const DEFAULT_WALLET_POLICY: WalletPolicy = {
  maxNativeSpendSol:        0.05,
  programAllowlist:         [],
  allowMessageSigning:      false,
  allowNativeTransfers:     true,
  allowProgramInteraction:  true,
  dryRun:                   false,
};

export const TOKEN_CREATION_POLICY: WalletPolicy = {
  ...DEFAULT_WALLET_POLICY,
  maxNativeSpendSol: 0.1,
};

export const DRY_RUN_POLICY: WalletPolicy = {
  ...DEFAULT_WALLET_POLICY,
  dryRun: true,
  allowMessageSigning: false,
  allowNativeTransfers: false,
  allowProgramInteraction: false,
};

export type WalletActionType =
  | 'connect'
  | 'sign_message'
  | 'sign_transaction'
  | 'send_transaction'
  | 'unknown';

export interface PolicyEvaluationContext {
  actionType:             WalletActionType;
  valueSol?:              number;
  totalSpentThisRunSol:   number;
  programId?:             string;
}

export interface PolicyDecision {
  allowed: boolean;
  reason:  string;
  dryRun:  boolean;
}

export function evaluatePolicy(
  policy: WalletPolicy,
  ctx: PolicyEvaluationContext,
): PolicyDecision {
  if (policy.dryRun) {
    return { allowed: false, reason: 'Dry-run policy — transaction not broadcast', dryRun: true };
  }

  if (ctx.actionType === 'sign_message') {
    return policy.allowMessageSigning
      ? { allowed: true, reason: 'Message signing permitted', dryRun: false }
      : { allowed: false, reason: 'Policy: message signing disabled', dryRun: false };
  }

  if (ctx.programId && policy.programAllowlist.length > 0) {
    const allowed = policy.programAllowlist.includes(ctx.programId);
    if (!allowed) {
      return { allowed: false, reason: `Policy: program ${ctx.programId} not in allowlist`, dryRun: false };
    }
  }

  const valueSol = ctx.valueSol ?? 0;
  const projected = ctx.totalSpentThisRunSol + valueSol;

  if (ctx.actionType === 'send_transaction' || ctx.actionType === 'sign_transaction') {
    if (!policy.allowProgramInteraction && !policy.allowNativeTransfers) {
      return { allowed: false, reason: 'Policy: transactions disabled', dryRun: false };
    }
    if (projected > policy.maxNativeSpendSol) {
      return {
        allowed: false,
        reason: `Policy: spend limit exceeded — projected ${projected.toFixed(6)} SOL > limit ${policy.maxNativeSpendSol} SOL`,
        dryRun: false,
      };
    }
    return { allowed: true, reason: `Transaction of up to ${valueSol} SOL permitted`, dryRun: false };
  }

  if (ctx.actionType === 'connect') {
    return { allowed: true, reason: 'Wallet connect permitted', dryRun: false };
  }

  return { allowed: true, reason: 'Action permitted by default policy', dryRun: false };
}

export function formatSpendLimit(sol: number): string {
  return `${sol.toFixed(6)} SOL`;
}

export function policyForFeatureType(featureType: string): WalletPolicy {
  switch (featureType) {
    case 'TOKEN_CREATION':
      return TOKEN_CREATION_POLICY;
    default:
      return DEFAULT_WALLET_POLICY;
  }
}
