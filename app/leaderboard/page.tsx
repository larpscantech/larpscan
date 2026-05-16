'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Navbar } from '@/components/navbar';
import { cn, truncateAddress } from '@/lib/utils';
import type { LeaderboardEntry } from '@/app/api/agents/leaderboard/route';

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── Rank decoration ───────────────────────────────────────────────────────────
const RANK_META: Record<number, { label: string; ring: string; glow: string; numColor: string }> = {
  1: {
    label:    '1st',
    ring:     'border-yellow-500/50',
    glow:     'shadow-[0_0_24px_rgba(234,179,8,0.12)]',
    numColor: 'text-yellow-400',
  },
  2: {
    label:    '2nd',
    ring:     'border-zinc-400/40',
    glow:     'shadow-[0_0_16px_rgba(161,161,170,0.08)]',
    numColor: 'text-zinc-300',
  },
  3: {
    label:    '3rd',
    ring:     'border-orange-600/40',
    glow:     'shadow-[0_0_14px_rgba(234,88,12,0.08)]',
    numColor: 'text-orange-400',
  },
};

function rankMeta(rank: number) {
  return RANK_META[rank] ?? {
    label:    `${rank}th`,
    ring:     'border-[#1f1f27]',
    glow:     '',
    numColor: 'text-zinc-600',
  };
}

// ── Skeleton ──────────────────────────────────────────────────────────────────
function Skeleton() {
  return (
    <div className="space-y-3">
      {[...Array(5)].map((_, i) => (
        <div
          key={i}
          className="h-20 bg-[#0a0a0e] border border-[#1f1f27] rounded-xl animate-pulse"
          style={{ opacity: 1 - i * 0.15 }}
        />
      ))}
    </div>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────
function LeaderboardRow({
  entry,
  rank,
  delay,
}: {
  entry: LeaderboardEntry;
  rank: number;
  delay: number;
}) {
  const meta = rankMeta(rank);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay }}
    >
      <Link
        href={`/agents/${entry.id}`}
        className={cn(
          'group flex items-center gap-4 px-5 py-4 bg-[#0a0a0e] border rounded-xl transition-all duration-150',
          'hover:bg-[#0e0e14] hover:border-[#2a2a35]',
          meta.ring,
          meta.glow,
        )}
      >
        {/* Rank number */}
        <span
          className={cn(
            'text-[13px] font-bold font-mono w-7 text-right flex-shrink-0',
            meta.numColor,
          )}
        >
          {rank}
        </span>

        {/* Avatar */}
        <div className="w-10 h-10 rounded-full bg-[#16161d] border border-[#2a2a35] flex items-center justify-center flex-shrink-0 overflow-hidden">
          {entry.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={entry.image} alt="" className="w-full h-full object-cover" />
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-600">
              <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
            </svg>
          )}
        </div>

        {/* Name + owner */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[13px] font-semibold text-white truncate">
              {entry.name}
            </span>
            <span className={cn(
              'text-[8px] font-bold uppercase tracking-[0.16em] px-1.5 py-0.5 rounded-sm border flex-shrink-0',
              entry.personality === 'larpscan'
                ? 'bg-emerald-900/20 text-emerald-500 border-emerald-700/30'
                : 'bg-zinc-900 text-zinc-500 border-zinc-700/40',
            )}>
              {entry.personality === 'larpscan' ? 'Larpscan' : 'Custom'}
            </span>
          </div>
          <p className="text-[10px] text-zinc-600 font-mono">
            {truncateAddress(entry.owner_address, 5, 4)} · {timeAgo(entry.created_at)}
          </p>
        </div>

        {/* Stats */}
        <div className="hidden sm:flex items-center gap-6 flex-shrink-0">
          <div className="text-center">
            <p className="text-[11px] font-bold font-mono text-white">{entry.totalRuns}</p>
            <p className="text-[8px] text-zinc-600 uppercase tracking-[0.14em]">Scans</p>
          </div>
          <div className="text-center">
            <p className="text-[11px] font-bold font-mono text-emerald-400">{entry.verified}</p>
            <p className="text-[8px] text-zinc-600 uppercase tracking-[0.14em]">Verified</p>
          </div>
          <div className="text-center">
            <p className="text-[11px] font-bold font-mono text-red-400">{entry.larp}</p>
            <p className="text-[8px] text-zinc-600 uppercase tracking-[0.14em]">Larps</p>
          </div>
        </div>

        {/* Pass rate badge */}
        <div className="flex-shrink-0 w-16 text-right">
          {entry.passRate !== null ? (
            <span className={cn(
              'text-[13px] font-bold font-mono',
              entry.passRate >= 80 ? 'text-emerald-400' :
              entry.passRate >= 50 ? 'text-yellow-400' :
              'text-red-400',
            )}>
              {entry.passRate}%
            </span>
          ) : (
            <span className="text-[11px] text-zinc-700 font-mono">—</span>
          )}
          <p className="text-[8px] text-zinc-600 uppercase tracking-[0.14em]">Pass rate</p>
        </div>

        {/* Chevron */}
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2"
          className="text-zinc-700 group-hover:text-zinc-400 transition-colors flex-shrink-0"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
      </Link>
    </motion.div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function LeaderboardPage() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/agents/leaderboard')
      .then(r => r.json())
      .then((data: { leaderboard: LeaderboardEntry[] }) => {
        setEntries(data.leaderboard ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-[#050507] text-white">
      <Navbar />

      <main className="pt-28 pb-24 px-4 sm:px-6 max-w-[760px] mx-auto">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22 }}
          className="mb-10"
        >
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-600 mb-2">
            BAP-578 · BNB Chain
          </p>
          <h1 className="text-[28px] sm:text-[32px] font-bold text-white leading-tight mb-2">
            Agent Leaderboard
          </h1>
          <p className="text-[13px] text-zinc-500 leading-relaxed">
            Ranked by verification quality — agents that catch the most larps
            while maintaining a high pass rate rise to the top.
          </p>
        </motion.div>

        {/* Column headers */}
        {!loading && entries.length > 0 && (
          <div className="flex items-center gap-4 px-5 mb-2">
            <span className="w-7" />
            <span className="w-10 flex-shrink-0" />
            <span className="flex-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-zinc-700">Agent</span>
            <div className="hidden sm:flex items-center gap-6 flex-shrink-0">
              <span className="w-10 text-center text-[9px] font-semibold uppercase tracking-[0.18em] text-zinc-700">Scans</span>
              <span className="w-10 text-center text-[9px] font-semibold uppercase tracking-[0.18em] text-zinc-700">Verified</span>
              <span className="w-10 text-center text-[9px] font-semibold uppercase tracking-[0.18em] text-zinc-700">Larps</span>
            </div>
            <span className="w-16 text-right text-[9px] font-semibold uppercase tracking-[0.18em] text-zinc-700">Pass rate</span>
            <span className="w-3 flex-shrink-0" />
          </div>
        )}

        {/* List */}
        {loading ? (
          <Skeleton />
        ) : entries.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="py-20 text-center"
          >
            <p className="text-[13px] text-zinc-500 mb-2">No agents have run scans yet.</p>
            <p className="text-[11px] text-zinc-700 mb-6">
              Mint an agent and start scanning to appear on the leaderboard.
            </p>
            <Link
              href="/agent/mint"
              className="text-[10px] font-semibold uppercase tracking-[0.2em] px-6 py-3 rounded-sm bg-red-600 text-white hover:bg-red-500 transition-colors"
            >
              Mint Agent
            </Link>
          </motion.div>
        ) : (
          <div className="space-y-2">
            {entries.map((entry, i) => (
              <LeaderboardRow
                key={entry.id}
                entry={entry}
                rank={i + 1}
                delay={i * 0.04}
              />
            ))}
          </div>
        )}

        {/* Footer note */}
        {!loading && entries.length > 0 && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="text-center text-[10px] text-zinc-700 mt-8"
          >
            Score = verified claims × log(total claims + 1) · updates every 60s
          </motion.p>
        )}

      </main>
    </div>
  );
}
