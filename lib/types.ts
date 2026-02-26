export type ScanType = 'full' | 'quick';

export type Phase =
  | 'idle'
  | 'extracting'
  | 'analyzing'
  | 'verifying'
  | 'reporting'
  | 'complete';

// Legacy alias used by pipeline-stepper
export type PipelineStage = Phase;

export type Verdict = 'VERIFIED' | 'LARP' | 'UNTESTABLE' | 'SITE_BROKEN' | 'FAILED';

export type JobStatus = 'in_progress' | 'complete' | 'failed';

export interface TokenProject {
  name: string;
  ticker: string;
  logoInitial?: string;
  website: string;
  xHandle: string;
  contractAddress: string;
}

export interface Claim {
  id: string;
  title: string;
  description: string;
  verdict?: Verdict;
  evidence?: string;
  screenshotDataUrl?: string;
  videoUrl?: string;
  transactionHash?: string;
  transactionExplorerUrl?: string;
  /** Solana confirmation status after mining; undefined for legacy evidence rows */
  transactionReceiptStatus?: 'success' | 'reverted' | 'timeout';
  /** True when a transaction was attempted but not confirmed (e.g. insufficient SOL) */
  transactionAttempted?: boolean;
  /** Investigation wallet address used during this verification */
  walletAddress?: string;
  /** Human-readable one-liner from the deterministic verdict rule (e.g. "Wallet connection required") */
  blockerReason?: string;
}

export interface VerificationJob {
  id: string;
  project: TokenProject;
  status: JobStatus;
  claims: Claim[];
  logs: string[];
  startedAt: string;
  completedAt?: string;
  estTimeSeconds?: number;
}

export interface RecentVerification {
  id: string;
  project: TokenProject;
  status: JobStatus;
  claimsTotal: number;
  claimsVerified: number;
  estTime?: string;
}
