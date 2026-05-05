'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useReadContract } from 'wagmi';
import { NFA_ABI, NFA_CONTRACT_ADDRESS } from '@/lib/nfa-contract';
import { cn } from '@/lib/utils';
import Link from 'next/link';

interface ConnectWalletButtonProps {
  className?: string;
  /** If true, show a "Mint Agent" nudge when connected but no NFA owned */
  showMintNudge?: boolean;
}

/** Reads how many NFAs the connected wallet holds. */
function useNfaBalance(address?: `0x${string}`) {
  return useReadContract({
    address: NFA_CONTRACT_ADDRESS,
    abi:     NFA_ABI,
    functionName: 'balanceOf',
    args:    address ? [address] : undefined,
    query:   { enabled: !!address && NFA_CONTRACT_ADDRESS !== '0x0000000000000000000000000000000000000000' },
  });
}

export function ConnectWalletButton({ className, showMintNudge = true }: ConnectWalletButtonProps) {
  const { address, isConnected } = useAccount();
  const { data: balance } = useNfaBalance(address);
  const hasAgent = typeof balance === 'bigint' && balance > 0n;

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <ConnectButton.Custom>
        {({ account, chain, openConnectModal, openAccountModal, mounted }) => {
          const ready = mounted;
          const connected = ready && account && chain;

          return (
            <button
              data-testid="connect-wallet-btn"
              onClick={connected ? openAccountModal : openConnectModal}
              className={cn(
                'text-[10px] font-semibold uppercase tracking-[0.22em] px-4 py-2.5 rounded-sm transition-all duration-150',
                connected
                  ? 'bg-[#16161d] border border-[#2a2a35] text-zinc-300 hover:border-zinc-500'
                  : 'bg-zinc-800 border border-zinc-700 text-zinc-200 hover:bg-zinc-700',
              )}
            >
              {connected ? account.displayName : 'Connect Wallet'}
            </button>
          );
        }}
      </ConnectButton.Custom>

      {isConnected && showMintNudge && !hasAgent && (
        <Link
          href="/agent/mint"
          data-testid="mint-agent-nudge"
          className="text-[10px] font-semibold uppercase tracking-[0.18em] px-3 py-2.5 rounded-sm bg-red-600/20 border border-red-600/40 text-red-400 hover:bg-red-600/30 transition-all duration-150 whitespace-nowrap"
        >
          Mint Agent
        </Link>
      )}

      {isConnected && hasAgent && (
        <Link
          href="/agent/mint"
          data-testid="agent-badge"
          className="text-[10px] font-semibold uppercase tracking-[0.18em] px-3 py-2.5 rounded-sm bg-emerald-900/30 border border-emerald-700/40 text-emerald-400 transition-all duration-150 whitespace-nowrap"
        >
          Agent Active
        </Link>
      )}
    </div>
  );
}
