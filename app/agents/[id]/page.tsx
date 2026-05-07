'use client';

import { useState, useEffect, use } from 'react';
import { useReadContract } from 'wagmi';
import { formatEther } from 'viem';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Navbar } from '@/components/navbar';
import { cn, truncateAddress } from '@/lib/utils';
import { NFA_ABI, NFA_CONTRACT_ADDRESS } from '@/lib/nfa-contract';
import type { DbAgent } from '@/lib/db-types';

// ── Types ─────────────────────────────────────────────────────────────────────
type AgentState = {
  balance:             bigint;
  status:              number;
  owner:               `0x${string}`;
  logicAddress:        `0x${string}`;
  lastActionTimestamp: bigint;
};

interface AgentStats {
  totalRuns:  number;
  total:      number;
  verified:   number;
  larp:       number;
  untestable: number;
  passRate:   number | null;
}

interface RecentRun {
  id:         string;
  status:     string;
  created_at: string;
}

interface MemoryEntry {
  id:          string;
  claim:       string;
  verdict:     string;
  projectName: string;
  created_at:  string;
}

interface AgentMemory {
  root:    string;
  count:   number;
  entries: MemoryEntry[];
}

// ── Constants ─────────────────────────────────────────────────────────────────
const STATUS_INFO: Record<number, { label: string; dot: string; text: string }> = {
  0: { label: 'Paused',     dot: 'bg-yellow-500',  text: 'text-yellow-400'  },
  1: { label: 'Active',     dot: 'bg-emerald-500', text: 'text-emerald-400' },
  2: { label: 'Terminated', dot: 'bg-red-500',     text: 'text-red-400'     },
};

const VERDICT_STYLE: Record<string, { badge: string; dot: string }> = {
  verified:   { badge: 'bg-emerald-900/30 text-emerald-400 border-emerald-700/30', dot: 'bg-emerald-500' },
  larp:       { badge: 'bg-red-900/30 text-red-400 border-red-700/30',             dot: 'bg-red-500'     },
  untestable: { badge: 'bg-zinc-800 text-zinc-500 border-zinc-700',                dot: 'bg-zinc-600'    },
};

const RUN_STATUS_COLOUR: Record<string, string> = {
  complete:   'bg-emerald-900/30 text-emerald-400 border-emerald-700/30',
  failed:     'bg-red-900/30 text-red-400 border-red-700/30',
  pending:    'bg-zinc-800 text-zinc-400 border-zinc-700',
  verifying:  'bg-blue-900/30 text-blue-400 border-blue-700/30',
  analyzing:  'bg-purple-900/30 text-purple-400 border-purple-700/30',
  extracting: 'bg-zinc-800 text-zinc-400 border-zinc-700',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-[#0a0a0e] border border-[#1f1f27] rounded-xl p-5">
      <p className="text-[10px] text-zinc-600 uppercase tracking-[0.18em] mb-1">{label}</p>
      <p className="text-[22px] font-bold text-white font-mono leading-none">{value}</p>
      {sub && <p className="text-[10px] text-zinc-600 mt-1">{sub}</p>}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [agent, setAgent]           = useState<DbAgent | null>(null);
  const [stats, setStats]           = useState<AgentStats | null>(null);
  const [recentRuns, setRecentRuns] = useState<RecentRun[]>([]);
  const [memory, setMemory]         = useState<AgentMemory | null>(null);
  const [loading, setLoading]       = useState(true);
  const [notFound, setNotFound]     = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/agents/${id}`)
      .then(r => r.json())
      .then(res => {
        if (!alive) return;
        if (res.error) { setNotFound(true); }
        else {
          setAgent(res.agent);
          setStats(res.stats);
          setRecentRuns(res.recentRuns ?? []);
          setMemory(res.memory ?? null);
        }
        setLoading(false);
      })
      .catch(() => { if (alive) { setNotFound(true); setLoading(false); } });
    return () => { alive = false; };
  }, [id]);

  // Live on-chain state
  const { data: stateData } = useReadContract({
    address:      NFA_CONTRACT_ADDRESS,
    abi:          NFA_ABI,
    functionName: 'getState',
    args:         agent?.token_id ? [BigInt(agent.token_id)] : undefined,
    query:        { enabled: !!agent?.token_id },
  });

  const chainState   = stateData as AgentState | undefined;
  const chainBalance = chainState ? formatEther(chainState.balance) : '—';
  const statusN      = chainState ? Number(chainState.status) : null;
  const statusInfo   = statusN !== null ? (STATUS_INFO[statusN] ?? STATUS_INFO[0]) : null;

  if (loading) {
    return (
      <div className="min-h-screen bg-[#050507] text-white">
        <Navbar />
        <main className="pt-28 pb-20 px-4 sm:px-6 max-w-[860px] mx-auto space-y-5">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-24 bg-[#0a0a0e] border border-[#1f1f27] rounded-xl animate-pulse" />
          ))}
        </main>
      </div>
    );
  }

  if (notFound || !agent) {
    return (
      <div className="min-h-screen bg-[#050507] text-white">
        <Navbar />
        <div className="flex items-center justify-center pt-40 text-center">
          <div>
            <p className="text-zinc-400 mb-4">Agent not found.</p>
            <Link href="/agents" className="text-[10px] font-semibold uppercase tracking-[0.2em] text-red-400 hover:text-red-300">
              ← Back to Agents
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050507] text-white">
      <Navbar />

      <main className="pt-28 pb-20 px-4 sm:px-6 max-w-[860px] mx-auto">

        {/* Back */}
        <Link href="/agents" className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-500 hover:text-zinc-300 transition-colors mb-8">
          ← Agents
        </Link>

        {/* Hero */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="bg-[#0a0a0e] border border-[#1f1f27] rounded-xl p-6 sm:p-8 flex items-start gap-5 mb-5"
        >
          <div className="w-14 h-14 rounded-full bg-[#16161d] border border-[#2a2a35] flex items-center justify-center flex-shrink-0 overflow-hidden">
            {agent.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={agent.image} alt="" className="w-full h-full object-cover" />
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-600">
                <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
              </svg>
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <h1 className="text-[20px] font-bold text-white">{agent.name}</h1>
              <span className={cn(
                'text-[9px] font-semibold uppercase tracking-[0.18em] px-2 py-0.5 rounded-sm border',
                agent.personality === 'larpscan'
                  ? 'bg-emerald-900/20 text-emerald-400 border-emerald-700/30'
                  : 'bg-zinc-900 text-zinc-400 border-zinc-700/40',
              )}>
                {agent.personality === 'larpscan' ? 'Larpscan' : 'Custom'}
              </span>
              {statusInfo && (
                <span className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-[0.18em]">
                  <span className={cn('w-1.5 h-1.5 rounded-full', statusInfo.dot)} />
                  <span className={statusInfo.text}>{statusInfo.label}</span>
                </span>
              )}
            </div>

            {agent.description && (
              <p className="text-[13px] text-zinc-400 leading-relaxed mb-3">{agent.description}</p>
            )}

            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-zinc-500 font-mono">
              {agent.token_id && (
                <span><span className="text-zinc-700 mr-1">Token</span>#{agent.token_id}</span>
              )}
              <span><span className="text-zinc-700 mr-1">Owner</span>{truncateAddress(agent.owner_address, 6, 4)}</span>
              <span><span className="text-zinc-700 mr-1">Minted</span>{timeAgo(agent.created_at)}</span>
              {agent.tx_hash && (
                <a
                  href={`https://bscscan.com/tx/${agent.tx_hash}`}
                  target="_blank" rel="noopener noreferrer"
                  className="hover:text-zinc-300 transition-colors"
                >
                  {truncateAddress(agent.tx_hash, 6, 4)} ↗
                </a>
              )}
            </div>
          </div>
        </motion.div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          <StatCard
            label="Balance"
            value={chainBalance === '—' ? '—' : Number(chainBalance).toFixed(4)}
            sub="BNB"
          />
          <StatCard label="Total Scans" value={stats?.totalRuns ?? 0} />
          <StatCard
            label="Pass Rate"
            value={stats?.passRate != null ? `${stats.passRate}%` : '—'}
            sub={stats?.total ? `${stats.verified} / ${stats.total} claims` : 'No scans yet'}
          />
          <StatCard label="Larp Catches" value={stats?.larp ?? 0} sub="failed claims" />
        </div>

        {/* Claim breakdown — only when there is data */}
        {stats && stats.total > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: 0.05 }}
            className="bg-[#0a0a0e] border border-[#1f1f27] rounded-xl p-5 mb-5"
          >
            <p className="text-[10px] text-zinc-600 uppercase tracking-[0.18em] mb-3">Claim Breakdown</p>
            <div className="flex gap-4">
              {[
                { label: 'Verified',   value: stats.verified,   colour: 'bg-emerald-500' },
                { label: 'Larp',       value: stats.larp,       colour: 'bg-red-500'     },
                { label: 'Untestable', value: stats.untestable, colour: 'bg-zinc-600'    },
              ].map(({ label, value, colour }) => (
                <div key={label} className="flex-1">
                  <div className="flex justify-between text-[10px] mb-1">
                    <span className="text-zinc-500">{label}</span>
                    <span className="text-zinc-300 font-mono">{value}</span>
                  </div>
                  <div className="h-1 bg-[#16161d] rounded-full overflow-hidden">
                    <div
                      className={cn('h-full rounded-full', colour)}
                      style={{ width: `${Math.round((value / stats.total) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}

        {/* Memory */}
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, delay: 0.1 }}
          className="bg-[#0a0a0e] border border-[#1f1f27] rounded-xl p-5 mb-5"
        >
          <div className="flex items-center justify-between mb-4">
            <p className="text-[10px] text-zinc-600 uppercase tracking-[0.18em]">Memory</p>
            {memory && memory.count > 0 && (
              <span className="text-[10px] text-zinc-700 font-mono">{memory.count} entries</span>
            )}
          </div>

          {/* Fingerprint chip */}
          {memory && memory.count > 0 ? (
            <>
              <div className="flex items-center gap-2.5 bg-[#0d0d12] border border-[#1a1a22] rounded-lg px-3 py-2.5 mb-4">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-600 flex-shrink-0">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                </svg>
                <span className="text-[11px] font-mono text-zinc-400 leading-none tracking-wide truncate">
                  {memory.root.slice(0, 10)}…{memory.root.slice(-8)}
                </span>
                <span className="ml-auto text-[9px] text-zinc-700 font-mono flex-shrink-0">fingerprint</span>
              </div>

              <div className="space-y-2">
                {memory.entries.map(entry => {
                  const vs = VERDICT_STYLE[entry.verdict] ?? VERDICT_STYLE.untestable;
                  return (
                    <div key={entry.id} className="flex items-start gap-2.5 py-2 border-b border-[#141419] last:border-0">
                      <span className={cn(
                        'text-[8px] font-bold uppercase tracking-[0.15em] px-1.5 py-0.5 rounded-sm border flex-shrink-0 mt-0.5',
                        vs.badge,
                      )}>
                        {entry.verdict}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] text-zinc-400 leading-snug line-clamp-2">{entry.claim}</p>
                        <p className="text-[9px] text-zinc-700 mt-0.5">{entry.projectName} · {timeAgo(entry.created_at)}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="py-6 text-center">
              <p className="text-[12px] text-zinc-600 mb-1">No memory recorded yet.</p>
              <p className="text-[11px] text-zinc-700">Each scan run by this agent builds its memory.</p>
            </div>
          )}
        </motion.div>

        {/* Recent Verifications */}
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, delay: 0.15 }}
          className="bg-[#0a0a0e] border border-[#1f1f27] rounded-xl p-5"
        >
          <p className="text-[10px] text-zinc-600 uppercase tracking-[0.18em] mb-4">Recent Verifications</p>

          {recentRuns.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-[12px] text-zinc-600 mb-1">No verifications yet.</p>
              <p className="text-[11px] text-zinc-700">Scans run by this agent will appear here once connected to the verification system.</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {recentRuns.map(run => (
                <div key={run.id} className="flex items-center gap-3">
                  <span className={cn(
                    'text-[9px] font-semibold uppercase tracking-[0.16em] px-2 py-0.5 rounded-sm border flex-shrink-0',
                    RUN_STATUS_COLOUR[run.status] ?? RUN_STATUS_COLOUR.pending,
                  )}>
                    {run.status}
                  </span>
                  <span className="text-[10px] text-zinc-600 font-mono flex-1 truncate">{run.id.slice(0, 16)}…</span>
                  <span className="text-[10px] text-zinc-700 flex-shrink-0">{timeAgo(run.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </motion.div>

      </main>
    </div>
  );
}
