'use client';

import { useState } from 'react';
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther } from 'viem';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { motion, AnimatePresence } from 'framer-motion';
import Link from 'next/link';
import { Navbar } from '@/components/navbar';
import { NFA_ABI, NFA_CONTRACT_ADDRESS, DEFAULT_AGENT_DATA } from '@/lib/nfa-contract';
import { cn, truncateAddress } from '@/lib/utils';

const IS_MOCK = NFA_CONTRACT_ADDRESS === '0x0000000000000000000000000000000000000000';

function AgentPreviewCard({ address }: { address?: string }) {
  return (
    <div
      data-testid="agent-preview-card"
      className="border border-[#1f1f27] rounded-xl bg-[#0a0a0e] p-6 w-full max-w-sm"
    >
      <div className="flex items-center gap-4 mb-5">
        <div className="w-14 h-14 rounded-lg bg-gradient-to-br from-red-900/60 to-zinc-900 border border-red-800/30 flex items-center justify-center text-2xl select-none">
          🤖
        </div>
        <div>
          <p className="text-white font-bold text-[15px]">{DEFAULT_AGENT_DATA.name}</p>
          <p className="text-zinc-500 text-[11px] font-mono mt-0.5">BAP-578 NFA</p>
        </div>
      </div>

      <div className="space-y-2 text-[12px]">
        <Row label="Chain"    value="BNB Chain" />
        <Row label="Standard" value="BAP-578 NFA" />
        <Row label="Type"     value="Verifier Agent" />
        <Row label="Memory"   value="JSON Light Memory" />
        <Row label="Model"    value={DEFAULT_AGENT_DATA.model} />
        {address && (
          <Row label="Owner" value={truncateAddress(address, 6, 4)} mono />
        )}
      </div>

      <p className="mt-5 text-[11px] text-zinc-600 leading-relaxed">
        {DEFAULT_AGENT_DATA.description}
      </p>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-zinc-500">{label}</span>
      <span className={cn('text-zinc-200', mono && 'font-mono')}>{value}</span>
    </div>
  );
}

export default function MintAgentPage() {
  const { address, isConnected } = useAccount();
  const [mintError, setMintError]   = useState<string | null>(null);
  const [mockMinted, setMockMinted] = useState(false);

  const { data: freeMints } = useReadContract({
    address:      NFA_CONTRACT_ADDRESS,
    abi:          NFA_ABI,
    functionName: 'freeMintCount',
    args:         address ? [address] : undefined,
    query:        { enabled: !!address && !IS_MOCK },
  });

  const { data: balance, refetch: refetchBalance } = useReadContract({
    address:      NFA_CONTRACT_ADDRESS,
    abi:          NFA_ABI,
    functionName: 'balanceOf',
    args:         address ? [address] : undefined,
    query:        { enabled: !!address && !IS_MOCK },
  });

  const hasAgent = IS_MOCK ? mockMinted : (typeof balance === 'bigint' && balance > 0n);
  const isFree   = IS_MOCK ? true       : (typeof freeMints === 'bigint' && freeMints < 3n);
  const mintFee  = isFree ? 0n : parseEther('0.01');

  const { writeContract, data: txHash, isPending: isMinting } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isMintedOnChain } = useWaitForTransactionReceipt({ hash: txHash });

  const handleMint = () => {
    setMintError(null);
    if (IS_MOCK) { setMockMinted(true); return; }
    try {
      writeContract({
        address:      NFA_CONTRACT_ADDRESS,
        abi:          NFA_ABI,
        functionName: 'mint',
        args:         [DEFAULT_AGENT_DATA],
        value:        mintFee,
      });
    } catch (e) {
      setMintError(e instanceof Error ? e.message : 'Transaction failed');
    }
  };

  const success = IS_MOCK ? mockMinted : isMintedOnChain;

  return (
    <div className="min-h-screen bg-[#050507] text-white">
      <Navbar />

      <main className="pt-28 pb-20 px-6 max-w-[860px] mx-auto">
        <div className="mb-10">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-500 mb-3">
            BAP-578 · BNB Chain
          </p>
          <h1 className="text-[28px] sm:text-[34px] font-bold leading-tight text-white mb-3">
            Mint Your AI Agent
          </h1>
          <p className="text-zinc-500 text-[14px] max-w-lg leading-relaxed">
            Own a Non-Fungible Agent on BNB Chain. Your agent runs real browser sessions
            to verify BSC token claims and builds a tamper-proof, on-chain track record
            under your wallet.
          </p>
        </div>

        <div className="flex flex-col lg:flex-row gap-8 items-start">
          {/* Left: action panel */}
          <div className="flex-1 space-y-5">
            {!isConnected ? (
              <div
                data-testid="connect-wallet-prompt"
                className="border border-[#1f1f27] rounded-xl bg-[#0a0a0e] p-8 text-center"
              >
                <p className="text-zinc-400 text-[13px] mb-5">
                  Connect your wallet to mint your free AI agent.
                </p>
                <ConnectButton />
              </div>
            ) : success ? (
              <AnimatePresence>
                <motion.div
                  data-testid="already-has-agent"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="border border-emerald-700/40 rounded-xl bg-emerald-900/10 p-8 text-center"
                >
                  <p className="text-emerald-400 font-bold text-[16px] mb-2">Agent Active ✓</p>
                  <p className="text-zinc-500 text-[13px] mb-5">
                    {IS_MOCK
                      ? 'Demo mint successful — deploy contract to go live on BNB Chain.'
                      : 'Your Larpscan verifier agent is live on BNB Chain.'}
                  </p>
                  <Link
                    href="/dashboard"
                    data-testid="go-to-dashboard-btn"
                    className="inline-block text-[10px] font-semibold uppercase tracking-[0.22em] px-6 py-3 rounded-sm bg-red-600 text-white hover:bg-red-500 transition-all duration-150"
                  >
                    Go to Dashboard →
                  </Link>
                </motion.div>
              </AnimatePresence>
            ) : (
              <div className="border border-[#1f1f27] rounded-xl bg-[#0a0a0e] p-6 space-y-5">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="text-zinc-500">Connected:</span>
                  <span className="font-mono text-zinc-300">{truncateAddress(address!, 6, 4)}</span>
                  <span className="ml-auto px-2 py-0.5 rounded-sm bg-emerald-900/30 border border-emerald-700/30 text-emerald-400 text-[10px] font-semibold uppercase tracking-wide">
                    BNB Chain
                  </span>
                </div>

                <div className="border-t border-[#1a1a22] pt-4 space-y-2 text-[12px]">
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Mint fee</span>
                    <span className={cn('font-mono', isFree ? 'text-emerald-400' : 'text-white')}>
                      {isFree ? 'FREE' : '0.01 BNB'}
                    </span>
                  </div>
                  {IS_MOCK && (
                    <div className="flex justify-between">
                      <span className="text-zinc-600">Contract</span>
                      <span className="text-zinc-600 font-mono text-[10px]">Mock (deploy pending)</span>
                    </div>
                  )}
                </div>

                <button
                  data-testid="mint-btn"
                  onClick={handleMint}
                  disabled={isMinting || isConfirming}
                  className={cn(
                    'w-full text-[11px] font-semibold uppercase tracking-[0.22em] py-3.5 rounded-sm transition-all duration-150',
                    isMinting || isConfirming
                      ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                      : 'bg-red-600 text-white hover:bg-red-500',
                  )}
                >
                  {isMinting     ? 'Confirm in wallet…'
                   : isConfirming ? 'Confirming on-chain…'
                   : IS_MOCK      ? 'Mint Agent (Demo)'
                   : `Mint Agent — ${isFree ? 'Free' : '0.01 BNB'}`}
                </button>

                {mintError && (
                  <p data-testid="mint-error" className="text-red-400 text-[11px]">
                    {mintError}
                  </p>
                )}
              </div>
            )}

            <div className="border border-[#1a1a22] rounded-xl p-5 space-y-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-500">
                What you get
              </p>
              {[
                'Your own AI verifier agent on BNB Chain',
                'Every audit you run is signed under your wallet',
                'On-chain track record — provably accurate, tamper-proof',
                'Tradeable asset — your agent gains value over time',
                '3 free mints per wallet · 0.01 BNB after that',
              ].map((item) => (
                <div key={item} className="flex items-start gap-2.5 text-[12px] text-zinc-400">
                  <span className="text-red-500 mt-0.5">✓</span>
                  {item}
                </div>
              ))}
            </div>
          </div>

          <div className="lg:w-auto">
            <AgentPreviewCard address={address} />
          </div>
        </div>
      </main>
    </div>
  );
}
