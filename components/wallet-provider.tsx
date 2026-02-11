'use client';

/** Pass-through wrapper — Solana scans use the server investigation wallet. */
export function WalletProviderWrapper({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
