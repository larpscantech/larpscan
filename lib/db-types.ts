// Database row types — mirrors the Supabase schema exactly.
// Keep these separate from frontend display types in lib/types.ts.

// ── Feature classification ─────────────────────────────────────────────────

export type FeatureType =
  | 'UI_FEATURE'       // generic interactive UI element
  | 'DEX_SWAP'         // token swap / AMM
  | 'TOKEN_CREATION'   // deploy / mint a token
  | 'API_FEATURE'      // publicly accessible REST/JSON endpoint
  | 'BOT'              // Telegram / Discord bot
  | 'CLI_TOOL'         // command-line tool
  | 'WALLET_FLOW'      // wallet-connect required flow
  | 'DATA_DASHBOARD';  // public leaderboard / stats / charts

export type VerificationStrategy =
  | 'ui+browser'       // Playwright browser interaction
  | 'ui+rpc'           // browser + on-chain RPC check
  | 'form+browser'     // fill form, submit, observe result
  | 'api+fetch'        // direct HTTP fetch to endpoint
  | 'message+bot'      // send message to bot (not automated)
  | 'terminal+cli'     // run CLI command (not automated)
  | 'wallet+rpc'       // wallet connect + RPC verification
  | 'dashboard+browser'; // navigate to page, check data presence

// Map from FeatureType → default VerificationStrategy
export const FEATURE_STRATEGY_MAP: Record<FeatureType, VerificationStrategy> = {
  UI_FEATURE:      'ui+browser',
  DEX_SWAP:        'ui+rpc',
  TOKEN_CREATION:  'form+browser',
  API_FEATURE:     'api+fetch',
  BOT:             'message+bot',
  CLI_TOOL:        'terminal+cli',
  WALLET_FLOW:     'wallet+rpc',
  DATA_DASHBOARD:  'dashboard+browser',
};

export type RunStatus =
  | 'pending'
  | 'extracting'
  | 'analyzing'
  | 'verifying'
  | 'complete'
  | 'failed';

export type ClaimStatus =
  | 'pending'
  | 'checking'
  | 'verified'
  | 'larp'
  | 'untestable'
  | 'failed';

export interface DbProject {
  id: string;
  contract_address: string;
  name: string;
  symbol: string;
  website: string | null;
  twitter: string | null;
  logo_url: string | null;
  description: string | null;
  chain: string;
  created_at: string;
}

export interface DbVerificationRun {
  id: string;
  project_id: string;
  status: RunStatus;
  claims_extracted: number;
  created_at: string;
}

export interface DbClaim {
  id: string;
  project_id: string;
  verification_run_id: string | null;
  claim: string;
  pass_condition: string;
  feature_type: FeatureType | null;
  surface: string | null;
  verification_strategy: VerificationStrategy | null;
  status: ClaimStatus;
  created_at: string;
}

export interface DbAgentLog {
  id: string;
  verification_run_id: string;
  message: string;
  created_at: string;
}

export interface DbEvidenceItem {
  id: string;
  claim_id: string;
  type: string;
  data: Record<string, unknown> | null;
  created_at: string;
}

// DbClaim enriched with its joined evidence_items (returned by verify/status)
export interface DbClaimWithEvidence extends DbClaim {
  evidence_items: Array<{
    id:         string;
    claim_id:   string;
    type:       string;
    data: {
      evidenceSummary?:        string;
      verdict?:                string;
      reasoning?:              string;
      confidence?:             string;
      screenshotDataUrl?:      string;
      videoUrl?:               string;  // /recordings/<claimId>.webm
      transactionHash?:        string;  // on-chain tx hash if submitted
      transactionExplorerUrl?: string;  // BscScan link
      transactionReceiptStatus?: 'success' | 'reverted' | 'timeout';
    } | null;
    created_at: string;
  }>;
}

// LLM output shape before persisting to DB
export interface ExtractedClaim {
  claim: string;
  pass_condition: string;
  feature_type: FeatureType;
  surface: string;
  verification_strategy: VerificationStrategy;
}
