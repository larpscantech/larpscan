/**
 * Post-transaction safety monitor for Solana.
 */

import { investigationConnection } from './client';
import type { WalletSnapshot, SnapshotDiff } from './snapshots';
import { diffSnapshots } from './snapshots';

export interface TxConfirmation {
  txHash:        string;
  status:        'success' | 'reverted' | 'timeout' | 'error';
  slot?:         number;
  errorMessage?: string;
}

export interface ApprovalRecord {
  tokenAddress: string;
  spender:      string;
  amountBefore: bigint;
  amountAfter:  bigint;
  increased:    boolean;
}

export interface SafetyReport {
  criticalIssues:    string[];
  warnings:          string[];
  txConfirmations:   TxConfirmation[];
  snapshotDiff?:     SnapshotDiff;
  approvalChanges:   ApprovalRecord[];
  unexpectedOutflow: boolean;
  haltRun:           boolean;
  summary:           string;
}

const RECEIPT_POLL_MS    = 2_000;
const RECEIPT_TIMEOUT_MS = 60_000;

export async function confirmTransaction(txHash: string): Promise<TxConfirmation> {
  console.log(`[wallet/monitor] Confirming tx ${txHash}`);
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const status = await investigationConnection.getSignatureStatus(txHash, {
        searchTransactionHistory: true,
      });
      const value = status?.value;
      if (value?.confirmationStatus === 'confirmed' || value?.confirmationStatus === 'finalized') {
        const ok = value.err === null;
        return {
          txHash,
          status: ok ? 'success' : 'reverted',
          slot: value.slot,
        };
      }
    } catch {
      /* poll again */
    }
    await new Promise<void>((r) => setTimeout(r, RECEIPT_POLL_MS));
  }

  return { txHash, status: 'timeout' };
}

export interface SafetyMonitorInput {
  snapshotBefore:           WalletSnapshot | null;
  snapshotAfter:            WalletSnapshot | null;
  txHashes:                 string[];
  expectedMaxOutflowLamports?: bigint;
}

export async function runSafetyMonitor(input: SafetyMonitorInput): Promise<SafetyReport> {
  const criticalIssues: string[] = [];
  const warnings: string[] = [];
  const txConfirmations: TxConfirmation[] = [];

  for (const hash of input.txHashes) {
    const confirmation = await confirmTransaction(hash);
    txConfirmations.push(confirmation);
    if (confirmation.status === 'reverted') {
      warnings.push(`Transaction ${hash} failed on-chain`);
    } else if (confirmation.status === 'timeout') {
      warnings.push(`Transaction ${hash} not confirmed within ${RECEIPT_TIMEOUT_MS / 1000}s`);
    }
  }

  let snapshotDiff: SnapshotDiff | undefined;
  let unexpectedOutflow = false;

  if (input.snapshotBefore && input.snapshotAfter) {
    snapshotDiff = diffSnapshots(
      input.snapshotBefore,
      input.snapshotAfter,
      input.expectedMaxOutflowLamports ?? BigInt(0),
    );
    unexpectedOutflow = snapshotDiff.unexpectedOutflow;
    if (unexpectedOutflow) {
      criticalIssues.push(
        `UNEXPECTED OUTFLOW: wallet lost ${snapshotDiff.nativeDeltaSol} beyond expected fees`,
      );
    }
  }

  const haltRun = criticalIssues.length > 0;
  const summaryParts: string[] = [];
  if (txConfirmations.length > 0) summaryParts.push(`${txConfirmations.length} tx(s) confirmed`);
  if (snapshotDiff) summaryParts.push(`Balance delta: ${snapshotDiff.nativeDeltaSol}`);
  if (unexpectedOutflow) summaryParts.push('⚠ UNEXPECTED OUTFLOW — run halted');
  if (criticalIssues.length === 0 && warnings.length === 0) {
    summaryParts.push('No safety issues detected');
  }

  return {
    criticalIssues,
    warnings,
    txConfirmations,
    snapshotDiff,
    approvalChanges: [],
    unexpectedOutflow,
    haltRun,
    summary: summaryParts.join(' | ') || 'Safety check complete',
  };
}

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
      lines.push(`  ${tx.status.toUpperCase()} ${tx.txHash} (slot ${tx.slot ?? 'pending'})`);
    }
  }
  return lines.join('\n');
}
