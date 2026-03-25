/**
 * lib/wallet/monitor.ts
 *
 * Post-transaction safety monitor.
 *
 * Responsibilities:
 *  - Compare pre/post wallet snapshots
 *  - Detect unexpected native token outflows
 *  - Detect unexpected token outflows
 *  - Detect unexpected approval creations or expansions
 *  - Confirm transaction receipts via NodeReal RPC
 *  - Emit structured safety findings for evidence
 */

import { formatEther, parseAbi } from 'viem';
import type { Address, Hash } from 'viem';
import { investigationPublicClient, investigationWalletAddress } from './client';
import type { WalletSnapshot, SnapshotDiff } from './snapshots';
import { diffSnapshots, formatDiff } from './snapshots';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TxConfirmation {
  txHash:        Hash;
  status:        'success' | 'reverted' | 'timeout' | 'error';
  blockNumber?:  bigint;
  gasUsed?:      bigint;
  errorMessage?: string;
}

export interface ApprovalRecord {
  tokenAddress:  Address;
  spender:       Address;
  amountBefore:  bigint;
  amountAfter:   bigint;
  increased:     boolean;
}

export interface SafetyReport {
  criticalIssues:      string[];
  warnings:            string[];
  txConfirmations:     TxConfirmation[];
  snapshotDiff?:       SnapshotDiff;
  approvalChanges:     ApprovalRecord[];
  unexpectedOutflow:   boolean;
  /** Should the verification run halt immediately */
  haltRun:             boolean;
  summary:             string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction confirmation
// ─────────────────────────────────────────────────────────────────────────────

const RECEIPT_POLL_MS      = 2_000;
const RECEIPT_TIMEOUT_MS   = 60_000;

export async function confirmTransaction(txHash: Hash): Promise<TxConfirmation> {
  console.log(`[wallet/monitor] Confirming tx ${txHash}`);
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const receipt = await investigationPublicClient.getTransactionReceipt({ hash: txHash });
      if (receipt) {
        const status: TxConfirmation['status'] =
          receipt.status === 'success' ? 'success' : 'reverted';
        console.log(`[wallet/monitor] Tx ${txHash} → ${status} (block ${receipt.blockNumber})`);
        return {
          txHash,
          status,
          blockNumber: receipt.blockNumber,
          gasUsed:     receipt.gasUsed,
        };
      }
    } catch (e) {
      // Receipt not yet available — poll again
    }
    await new Promise<void>((r) => setTimeout(r, RECEIPT_POLL_MS));
  }

  console.warn(`[wallet/monitor] Tx ${txHash} confirmation timed out`);
  return { txHash, status: 'timeout' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Approval snapshot
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWANCE_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
]);

export async function readAllowance(
  tokenAddress: Address,
  spender:      Address,
): Promise<bigint> {
  const owner = investigationWalletAddress;
  if (!owner) return BigInt(0);

  return investigationPublicClient
    .readContract({
      address:      tokenAddress,
      abi:          ALLOWANCE_ABI,
      functionName: 'allowance',
      args:         [owner, spender],
    })
    .catch(() => BigInt(0)) as Promise<bigint>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Safety report generation
// ─────────────────────────────────────────────────────────────────────────────

export interface SafetyMonitorInput {
  snapshotBefore:     WalletSnapshot | null;
  snapshotAfter:      WalletSnapshot | null;
  txHashes:           Hash[];
  approvalTokens?:    { tokenAddress: Address; spender: Address; amountBefore: bigint }[];
  /** Expected maximum BNB outflow (value + estimated gas) */
  expectedMaxOutflowWei?: bigint;
}

export async function runSafetyMonitor(input: SafetyMonitorInput): Promise<SafetyReport> {
  const criticalIssues: string[] = [];
  const warnings:       string[] = [];
  const txConfirmations: TxConfirmation[] = [];
  const approvalChanges: ApprovalRecord[] = [];

  // ── Confirm transactions ────────────────────────────────────────────────
  for (const hash of input.txHashes) {
    const confirmation = await confirmTransaction(hash);
    txConfirmations.push(confirmation);

    if (confirmation.status === 'reverted') {
      warnings.push(`Transaction ${hash} reverted on-chain`);
    } else if (confirmation.status === 'timeout') {
      warnings.push(`Transaction ${hash} not confirmed within ${RECEIPT_TIMEOUT_MS / 1000}s`);
    }
  }

  // ── Snapshot diff ──────────────────────────────────────────────────────
  let snapshotDiff: SnapshotDiff | undefined;
  let unexpectedOutflow = false;

  if (input.snapshotBefore && input.snapshotAfter) {
    snapshotDiff     = diffSnapshots(
      input.snapshotBefore,
      input.snapshotAfter,
      input.expectedMaxOutflowWei ?? BigInt(0),
    );
    unexpectedOutflow = snapshotDiff.unexpectedOutflow;

    if (unexpectedOutflow) {
      criticalIssues.push(
        `UNEXPECTED OUTFLOW: wallet lost ${snapshotDiff.nativeDeltaEther} beyond expected gas/value`,
      );
    }

    for (const td of snapshotDiff.tokenDeltas) {
      if (td.direction === 'out') {
        criticalIssues.push(
          `UNEXPECTED TOKEN OUTFLOW: ${td.symbol} (${td.address}) decreased by ${td.deltaRaw}`,
        );
        unexpectedOutflow = true;
      }
    }
  }

  // ── Approval changes ───────────────────────────────────────────────────
  for (const approval of input.approvalTokens ?? []) {
    try {
      const amountAfter = await readAllowance(approval.tokenAddress, approval.spender);
      const increased   = amountAfter > approval.amountBefore;

      approvalChanges.push({
        tokenAddress: approval.tokenAddress,
        spender:      approval.spender,
        amountBefore: approval.amountBefore,
        amountAfter,
        increased,
      });

      if (increased && amountAfter > BigInt('1000000000000000000000000')) {
        criticalIssues.push(
          `SUSPICIOUS APPROVAL: token ${approval.tokenAddress} spender ${approval.spender} ` +
          `allowance increased to ${amountAfter} (possible drainer)`,
        );
      } else if (increased) {
        warnings.push(
          `Approval increased: token ${approval.tokenAddress} spender ${approval.spender} ` +
          `${approval.amountBefore} → ${amountAfter}`,
        );
      }
    } catch (e) {
      warnings.push(`Could not check approval for ${approval.tokenAddress}: ${e}`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────
  const haltRun = criticalIssues.length > 0;

  const summaryParts: string[] = [];
  if (txConfirmations.length > 0) {
    summaryParts.push(`${txConfirmations.length} tx(s) confirmed`);
  }
  if (snapshotDiff) {
    summaryParts.push(`Balance delta: ${snapshotDiff.nativeDeltaEther}`);
  }
  if (unexpectedOutflow) {
    summaryParts.push('⚠ UNEXPECTED OUTFLOW — run halted');
  }
  if (criticalIssues.length === 0 && warnings.length === 0) {
    summaryParts.push('No safety issues detected');
  }

  return {
    criticalIssues,
    warnings,
    txConfirmations,
    snapshotDiff,
    approvalChanges,
    unexpectedOutflow,
    haltRun,
    summary: summaryParts.join(' | ') || 'Safety check complete',
  };
}

/** Format a safety report for the evidence string */
export function formatSafetyReport(r: SafetyReport): string {
  const lines: string[] = ['=== WALLET SAFETY REPORT ===', r.summary];

  if (r.criticalIssues.length > 0) {
    lines.push('CRITICAL:');
    r.criticalIssues.forEach((i) => lines.push(`  ✗ ${i}`));
  }

  if (r.warnings.length > 0) {
    lines.push('Warnings:');
    r.warnings.forEach((w) => lines.push(`  ⚠ ${w}`));
  }

  if (r.txConfirmations.length > 0) {
    lines.push('Transactions:');
    for (const tx of r.txConfirmations) {
      lines.push(`  ${tx.status.toUpperCase()} ${tx.txHash} (block ${tx.blockNumber ?? 'pending'})`);
    }
  }

  if (r.snapshotDiff) {
    lines.push('Balance diff:');
    lines.push(`  ${r.snapshotDiff.nativeDeltaEther}`);
  }

  return lines.join('\n');
}
