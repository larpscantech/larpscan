'use client';

import { cn } from '@/lib/utils';

interface ConnectWalletButtonProps {
  className?: string;
}

/** Dashboard wallet UI removed — scans use the server investigation wallet. */
export function ConnectWalletButton({ className }: ConnectWalletButtonProps) {
  return (
    <span
      className={cn(
        'text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-600 hidden sm:inline',
        className,
      )}
    >
      Solana
    </span>
  );
}
