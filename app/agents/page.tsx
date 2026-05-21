'use client';

import { useState, useEffect, useCallback } from 'react'; // useCallback used in fetchAgents
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther, formatEther, parseGwei } from 'viem';
import { motion, AnimatePresence } from 'framer-motion';
import Link from 'next/link';
import { Navbar } from '@/components/navbar';
import { cn, truncateAddress } from '@/lib/utils';
import { NFA_ABI, NFA_CONTRACT_ADDRESS } from '@/lib/nfa-contract';
import type { DbAgent } from '@/lib/db-types';

// BSC minimum gas price — keeps transactions from getting stuck
const BSC_GAS_PRICE = parseGwei('3');

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Status enum from contract: 0 = Paused, 1 = Active, 2 = Terminated
const STATUS_INFO: Record<number, { label: string; colour: string }> = {
  0: { label: 'Paused',     colour: 'bg-yellow-500'  },
  1: { label: 'Active',     colour: 'bg-emerald-500' },
  2: { label: 'Terminated', colour: 'bg-red-500'     },
};

type AgentState = { balance: bigint; status: number; owner: `0x${string}`; logicAddress: `0x${string}`; lastActionTimestamp: bigint };

// ── On-chain manage panel ─────────────────────────────────────────────────────
function ManagePanel({ agent }: { agent: DbAgent }) {
  const tid = BigInt(agent.token_id!);

  const [fundAmount, setFundAmount]           = useState('');
  const [withdrawAmount, setWithdrawAmount]   = useState('');
  const [activeAction, setActiveAction]       = useState<'fund' | 'withdraw' | null>(null);
  const [txError, setTxError]                 = useState<string | null>(null);
  const [pauseSubmitting, setPauseSubmitting] = useState(false);

  // Read on-chain state
  const { data: stateData, refetch } = useReadContract({
    address:      NFA_CONTRACT_ADDRESS,
    abi:          NFA_ABI,
    functionName: 'getState',
    args:         [tid],
  });

  const state    = stateData as AgentState | undefined;
  const balance  = state ? formatEther(state.balance) : '—';
  const statusN  = state ? Number(state.status) : 0;
  const statusInfo = STATUS_INFO[statusN] ?? STATUS_INFO[0];
  const isActive = statusN === 1; // 1 = Active, 0 = Paused

  // Fund
  const { writeContract: fund, data: fundHash, isPending: isFunding } = useWriteContract();
  const { isLoading: fundConfirming, isSuccess: fundDone, isError: fundFailed } = useWaitForTransactionReceipt({ hash: fundHash });
  useEffect(() => {
    if (fundDone)   { setFundAmount(''); setActiveAction(null); setTxError(null); refetch(); }
    if (fundFailed) setTxError('Fund transaction failed on-chain.');
  }, [fundDone, fundFailed, refetch]);

  // Withdraw
  const { writeContract: withdraw, data: withdrawHash, isPending: isWithdrawing } = useWriteContract();
  const { isLoading: withdrawConfirming, isSuccess: withdrawDone, isError: withdrawFailed } = useWaitForTransactionReceipt({ hash: withdrawHash });
  useEffect(() => {
    if (withdrawDone)   { setWithdrawAmount(''); setActiveAction(null); setTxError(null); refetch(); }
    if (withdrawFailed) setTxError('Withdraw transaction failed on-chain.');
  }, [withdrawDone, withdrawFailed, refetch]);

  // Pause / unpause
  const { writeContract: togglePause, data: pauseHash, isPending: isPauseLoading } = useWriteContract();
  const { isLoading: pauseConfirming, isSuccess: pauseDone, isError: pauseFailed } = useWaitForTransactionReceipt({ hash: pauseHash });
  useEffect(() => {
    if (pauseDone)   { setTxError(null); setPauseSubmitting(false); refetch(); }
    if (pauseFailed) { setTxError('Pause transaction failed — check BscScan for details.'); setPauseSubmitting(false); }
  }, [pauseDone, pauseFailed, refetch]);

  const isBusy = isFunding || fundConfirming || isWithdrawing || withdrawConfirming || isPauseLoading || pauseConfirming || pauseSubmitting;

  const handleFund = () => {
    if (!fundAmount) return;
    setTxError(null);
    fund(
      { address: NFA_CONTRACT_ADDRESS, abi: NFA_ABI, functionName: 'fundAgent', args: [tid], value: parseEther(fundAmount), gasPrice: BSC_GAS_PRICE },
      {
        onError: (err) => setTxError(err.message.includes('User rejected') ? 'Cancelled.' : err.message.slice(0, 120)),
      },
    );
  };

  const handleWithdraw = () => {
    if (!withdrawAmount) return;
    setTxError(null);
    withdraw(
      { address: NFA_CONTRACT_ADDRESS, abi: NFA_ABI, functionName: 'withdrawFromAgent', args: [tid, parseEther(withdrawAmount)], gasPrice: BSC_GAS_PRICE },
      {
        onError: (err) => setTxError(err.message.includes('User rejected') ? 'Cancelled.' : err.message.slice(0, 120)),
      },
    );
  };

  const handlePauseToggle = () => {
    if (pauseSubmitting) return;
    setTxError(null);
    setPauseSubmitting(true);
    const fn = isActive ? 'pause' : 'unpause';
    togglePause(
      { address: NFA_CONTRACT_ADDRESS, abi: NFA_ABI, functionName: fn, args: [tid], gasPrice: BSC_GAS_PRICE },
      {
        onError: (err) => {
          setTxError(err.message.includes('User rejected') ? 'Transaction cancelled.' : err.message.slice(0, 120));
          setPauseSubmitting(false);
        },
      },
    );
  };

  return (
    <div className="border-t border-[#1a1a22] pt-4 space-y-4">

      {/* Balance + status */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] text-zinc-600 uppercase tracking-[0.16em] mb-0.5">Balance</p>
          <p className="font-mono text-[14px] font-semibold text-white">{balance} BNB</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-zinc-600 uppercase tracking-[0.16em] mb-0.5">Status</p>
          <div className="flex items-center gap-1.5 justify-end">
            <div className={cn('w-1.5 h-1.5 rounded-full', statusInfo.colour)} />
            <p className="text-[12px] text-zinc-300 font-semibold">{statusInfo.label}</p>
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="grid grid-cols-3 gap-1.5">
        {(['fund', 'withdraw'] as const).map(a => (
          <button
            key={a}
            type="button"
            onClick={() => setActiveAction(activeAction === a ? null : a)}
            className={cn(
              'text-[10px] font-semibold uppercase tracking-[0.16em] py-2 rounded-sm border transition-all',
              activeAction === a
                ? 'border-red-600/60 bg-red-600/10 text-white'
                : 'border-[#2a2a35] text-zinc-500 hover:text-zinc-300 hover:border-zinc-500',
            )}
          >
            {a === 'fund' ? '+ Fund' : '− Withdraw'}
          </button>
        ))}
        <button
          type="button"
          onClick={handlePauseToggle}
          disabled={isBusy || statusN === 2} // 2 = Terminated, can't pause/resume
          className={cn(
            'text-[10px] font-semibold uppercase tracking-[0.16em] py-2 rounded-sm border transition-all disabled:opacity-40',
            isActive
              ? 'border-yellow-700/40 text-yellow-500 hover:border-yellow-600/60'
              : statusN === 0
                ? 'border-emerald-700/40 text-emerald-400 hover:border-emerald-600/60'
                : 'border-zinc-700/40 text-zinc-500 cursor-not-allowed',
          )}
        >
          {isPauseLoading || pauseConfirming || pauseSubmitting ? '…' : isActive ? 'Pause' : statusN === 0 ? 'Resume' : 'Terminated'}
        </button>
      </div>

      {/* Error banner */}
      {txError && (
        <p className="text-red-400 text-[11px] bg-red-900/10 border border-red-900/30 rounded-sm px-3 py-2">{txError}</p>
      )}

      {/* Fund input */}
      <AnimatePresence>
        {activeAction === 'fund' && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.15 }} className="overflow-hidden">
            <div className="flex gap-2 pt-1">
              <input type="number" min="0" step="0.001" value={fundAmount} onChange={e => setFundAmount(e.target.value)} placeholder="0.00 BNB"
                className="flex-1 bg-[#0d0d12] border border-[#1f1f27] rounded-sm px-3 py-2 text-[12px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 font-mono" />
              <button type="button" onClick={handleFund} disabled={isBusy || !fundAmount}
                className="text-[10px] font-semibold uppercase tracking-[0.16em] px-4 py-2 rounded-sm bg-red-600 text-white hover:bg-red-500 disabled:opacity-40 transition-all">
                {isFunding || fundConfirming ? '…' : 'Fund'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Withdraw input */}
      <AnimatePresence>
        {activeAction === 'withdraw' && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.15 }} className="overflow-hidden">
            <div className="flex gap-2 pt-1">
              <input type="number" min="0" step="0.001" value={withdrawAmount} onChange={e => setWithdrawAmount(e.target.value)} placeholder="0.00 BNB"
                className="flex-1 bg-[#0d0d12] border border-[#1f1f27] rounded-sm px-3 py-2 text-[12px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 font-mono" />
              <button type="button" onClick={handleWithdraw} disabled={isBusy || !withdrawAmount}
                className="text-[10px] font-semibold uppercase tracking-[0.16em] px-4 py-2 rounded-sm bg-zinc-700 text-white hover:bg-zinc-600 disabled:opacity-40 transition-all">
                {isWithdrawing || withdrawConfirming ? '…' : 'Withdraw'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Agent card ────────────────────────────────────────────────────────────────
function AgentCard({ agent, isOwner }: { agent: DbAgent; isOwner: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.18 }}
      className="border border-[#1f1f27] rounded-xl bg-[#0a0a0e] p-5 flex flex-col gap-3 hover:border-zinc-700 transition-colors"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-full bg-[#16161d] border border-[#2a2a35] flex items-center justify-center flex-shrink-0 overflow-hidden">
            {agent.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={agent.image} alt="" className="w-full h-full object-cover" />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-600">
                <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
              </svg>
            )}
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-white truncate">{agent.name}</p>
            <p className="text-[10px] text-zinc-500 font-mono mt-0.5">{truncateAddress(agent.owner_address, 6, 4)}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {isOwner && (
            <span className="text-[9px] font-semibold uppercase tracking-[0.18em] px-2 py-0.5 rounded-sm bg-red-600/15 text-red-400 border border-red-600/20">
              Yours
            </span>
          )}
          <span className={cn(
            'text-[9px] font-semibold uppercase tracking-[0.18em] px-2 py-0.5 rounded-sm border',
            agent.personality === 'larpscan'
              ? 'bg-emerald-900/20 text-emerald-400 border-emerald-700/30'
              : 'bg-zinc-900 text-zinc-400 border-zinc-700/40',
          )}>
            {agent.personality === 'larpscan' ? 'Larpscan' : 'Custom'}
          </span>
        </div>
      </div>

      {agent.description && (
        <p className="text-[12px] text-zinc-500 leading-relaxed line-clamp-2">{agent.description}</p>
      )}

      {/* Footer */}
      <div className="flex items-center gap-4 text-[10px] text-zinc-600 font-mono border-t border-[#16161d] pt-3">
        {agent.token_id && <span><span className="text-zinc-700 mr-1">ID</span>#{agent.token_id}</span>}
        {agent.tx_hash && (
          <a href={`https://bscscan.com/tx/${agent.tx_hash}`} target="_blank" rel="noopener noreferrer" className="hover:text-zinc-400 transition-colors">
            {truncateAddress(agent.tx_hash, 6, 4)} ↗
          </a>
        )}
        <span className="ml-auto">{timeAgo(agent.created_at)}</span>
      </div>

      {/* Action row */}
      <div className={cn('grid gap-1.5', isOwner && agent.token_id ? 'grid-cols-2' : 'grid-cols-1')}>
        <Link
          href={`/agents/${agent.id}`}
          className="text-center text-[10px] font-semibold uppercase tracking-[0.2em] py-2 rounded-sm border border-[#2a2a35] text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-all"
        >
          View Details
        </Link>
        {isOwner && agent.token_id && (
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="text-[10px] font-semibold uppercase tracking-[0.2em] py-2 rounded-sm border border-[#2a2a35] text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-all"
          >
            {expanded ? '▲ Hide' : '▼ Manage'}
          </button>
        )}
      </div>

      <AnimatePresence>
        {expanded && agent.token_id && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <ManagePanel agent={agent} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
type Tab = 'all' | 'mine';

export default function AgentsPage() {
  const { address, isConnected } = useAccount();
  const [tab, setTab]         = useState<Tab>('all');
  const [agents, setAgents]   = useState<DbAgent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAgents = useCallback(async (activeTab: Tab, walletAddress?: string) => {
    setLoading(true);
    try {
      if (activeTab === 'mine' && walletAddress) {
        const res  = await fetch(`/api/agents?owner=${walletAddress.toLowerCase()}`);
        const data = await res.json();
        setAgents(data.agents ?? []);
      } else {
        const res  = await fetch('/api/agents/leaderboard');
        const data = await res.json() as { leaderboard?: Array<{
          id: string; name: string; image: string | null; personality: string;
          owner_address: string; token_id: string | null; created_at: string;
        }> };
        setAgents((data.leaderboard ?? []).map(e => ({
          id:            e.id,
          owner_address: e.owner_address,
          token_id:      e.token_id,
          tx_hash:       null,
          name:          e.name,
          description:   null,
          image:         e.image,
          personality:   e.personality as 'larpscan' | 'custom',
          system_prompt: null,
          chain:         'bsc',
          created_at:    e.created_at,
        })));
      }
    } catch {
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAgents(tab, address ?? undefined);
  }, [tab, address, fetchAgents]);

  return (
    <div className="min-h-screen bg-[#050507] text-white">
      <Navbar />

      <main className="pt-28 pb-20 px-4 sm:px-6 max-w-[1100px] mx-auto">
        <div className="mb-8">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-500 mb-2">BAP-578 · BNB Chain</p>
          <h1 className="text-[26px] sm:text-[30px] font-bold text-white">Agents</h1>
        </div>

        <div className="flex items-center gap-1 p-1 bg-[#0a0a0e] border border-[#1f1f27] rounded-sm w-fit mb-8">
          {(['all', 'mine'] as Tab[]).map(t => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className={cn('text-[10px] font-semibold uppercase tracking-[0.2em] px-5 py-2 rounded-sm transition-all',
                tab === t ? 'bg-[#16161d] text-white' : 'text-zinc-500 hover:text-zinc-300')}>
              {t === 'all' ? 'All Agents' : 'My Agents'}
            </button>
          ))}
        </div>

        {tab === 'mine' && !isConnected && (
          <div className="border border-[#1f1f27] rounded-xl bg-[#0a0a0e] p-12 text-center">
            <p className="text-zinc-400 text-[13px] mb-1">Connect your wallet to see your agents.</p>
            <p className="text-zinc-600 text-[12px]">
              Or switch to <button onClick={() => setTab('all')} className="underline hover:text-zinc-400">All Agents</button>.
            </p>
          </div>
        )}

        {loading && (tab === 'all' || isConnected) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="border border-[#1f1f27] rounded-xl bg-[#0a0a0e] p-5 animate-pulse">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-9 h-9 rounded-full bg-[#16161d]" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 bg-[#16161d] rounded w-2/3" />
                    <div className="h-2.5 bg-[#16161d] rounded w-1/3" />
                  </div>
                </div>
                <div className="h-2.5 bg-[#16161d] rounded w-full mb-2" />
                <div className="h-2.5 bg-[#16161d] rounded w-4/5" />
              </div>
            ))}
          </div>
        )}

        {!loading && agents.length === 0 && (tab === 'all' || isConnected) && (
          <div className="border border-[#1f1f27] rounded-xl bg-[#0a0a0e] p-12 text-center">
            <p className="text-zinc-400 text-[13px] mb-4">
              {tab === 'mine' ? "You haven't minted an agent yet." : 'No agents minted yet.'}
            </p>
            <Link href="/agent/mint" className="inline-block text-[10px] font-semibold uppercase tracking-[0.22em] px-7 py-3 rounded-sm bg-red-600 text-white hover:bg-red-500 transition-all">
              Mint the First Agent
            </Link>
          </div>
        )}

        {!loading && agents.length > 0 && (
          <motion.div layout className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <AnimatePresence mode="popLayout">
              {agents.map(agent => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  isOwner={!!address && agent.owner_address.toLowerCase() === address.toLowerCase()}
                />
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </main>
    </div>
  );
}
