/**
 * Normalize feature type for agent guidance and verdict rules.
 *
 * Discover often routes on-chain creation claims as WALLET_FLOW, but verdict
 * rules for TOKEN_CREATION require a Solana transaction — not a bot link or
 * form-only evidence.
 */
export function resolveEffectiveFeatureType(
  featureType: string | undefined,
  claim: string,
): string {
  const ft = featureType ?? 'UI_FEATURE';
  if (ft === 'TOKEN_CREATION' || ft === 'ONCHAIN_TOKEN_CREATE') return 'TOKEN_CREATION';
  if (isOnChainCreationClaim(ft, claim)) return 'TOKEN_CREATION';
  return ft;
}

export function isOnChainCreationClaim(
  featureType: string | undefined,
  claim: string,
): boolean {
  const ft = featureType ?? 'UI_FEATURE';
  if (ft !== 'WALLET_FLOW' && ft !== 'wallet+rpc') return false;
  return /(create|launch|deploy|mint)\b.*\b(token|coin|nft|meme|agent)/i.test(claim);
}
