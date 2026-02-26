/** @deprecated Import from '@/lib/solana' instead. Re-exports for backward compatibility. */
export {
  solanaConnection as rpcClient,
  validateMint as validateContract,
  getTokenMetadata,
  analyzeTokenOnChain as analyzeContractOnChain,
  formatOnChainEvidence,
  isValidMintAddress,
  solScanTxUrl,
  solScanAddressUrl,
} from './solana';

export type { OnChainReport, LiquidityPair } from './solana';
