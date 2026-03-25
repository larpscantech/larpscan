'use client';

import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { StatusBadge } from './status-badge';
import { cn } from '@/lib/utils';
import type { Claim, Verdict } from '@/lib/types';
import type { BadgeVariant } from './status-badge';

function verdictToBadge(verdict: Verdict): BadgeVariant {
  switch (verdict) {
    case 'VERIFIED':    return 'verified';
    case 'LARP':        return 'larp';
    case 'FAILED':      return 'failed';
    case 'UNTESTABLE':  return 'untestable';
    case 'SITE_BROKEN': return 'site-broken';
  }
}

function verdictBorderColor(verdict?: Verdict): string {
  if (!verdict) return 'border-l-[#26262e]';
  switch (verdict) {
    case 'VERIFIED':    return 'border-l-emerald-700/70';
    case 'LARP':
    case 'FAILED':      return 'border-l-[#b91c1c]/80';
    case 'UNTESTABLE':  return 'border-l-zinc-600/50';
    case 'SITE_BROKEN': return 'border-l-amber-700/60';
    default:            return 'border-l-[#26262e]';
  }
}

// Cycles through messages while a claim is being actively tested
const CHECKING_MESSAGES = [
  'Checking endpoint behavior...',
  'Observing UI responses...',
  'Validating pass condition...',
  'Collecting evidence...',
];

function CheckingIndicator() {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setIdx((i) => (i + 1) % CHECKING_MESSAGES.length), 2400);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex items-center gap-3">
      <div className="flex gap-[5px]">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="block w-[5px] h-[5px] rounded-full bg-[#dc2626]/60"
            animate={{ opacity: [0.25, 1, 0.25] }}
            transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.28, ease: 'easeInOut' }}
          />
        ))}
      </div>
      <AnimatePresence mode="wait">
        <motion.span
          key={idx}
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 4 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className="text-[11px] font-mono text-zinc-600"
        >
          {CHECKING_MESSAGES[idx]}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

interface AuditClaimCardProps {
  claim: Claim;
  index: number;
  defaultExpanded?: boolean;
  isChecking?: boolean;
}

export function AuditClaimCard({
  claim,
  index,
  defaultExpanded = false,
  isChecking = false,
}: AuditClaimCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Auto-expand the instant a verdict arrives after checking
  const wasCheckingRef = useRef(isChecking);
  useEffect(() => {
    if (wasCheckingRef.current && !isChecking && claim.verdict) {
      setExpanded(true);
    }
    wasCheckingRef.current = isChecking;
  }, [isChecking, claim.verdict]);

  // Sync defaultExpanded changes (e.g. reporting phase forces all open)
  useEffect(() => {
    if (defaultExpanded) setExpanded(true);
  }, [defaultExpanded]);

  const borderClass = isChecking
    ? 'border-l-[#dc2626]/40'
    : verdictBorderColor(claim.verdict);

  return (
    <div
      className={cn(
        'border-l-[3px] pl-7 pr-7 py-6 mb-1.5',
        'bg-cv-card rounded-xl shadow-card',
        'hover:bg-cv-elevated hover:shadow-card-hover',
        'transition-colors duration-200',
        borderClass,
      )}
    >
      <div className="flex items-start gap-6">
        {/* Large ordinal */}
        <span
          className="font-mono text-[38px] font-bold leading-none flex-shrink-0 select-none w-12 text-right tabular-nums"
          style={{ color: '#1e1e26' }}
        >
          {String(index + 1).padStart(2, '0')}
        </span>

        {/* Content */}
        <div className="flex-1 min-w-0 pt-1">
          <div className="flex items-start justify-between gap-5 mb-2">
            <h3 className="text-[15px] font-bold uppercase tracking-wide text-white leading-snug">
              {claim.title}
            </h3>

            {/* Verdict badge — fades in the moment the verdict arrives */}
            <AnimatePresence>
              {claim.verdict && !isChecking && (
                <motion.div
                  key="badge"
                  initial={{ opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.28, ease: 'easeOut' }}
                  className="flex-shrink-0 mt-0.5"
                >
                  <StatusBadge variant={verdictToBadge(claim.verdict)} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <p className="text-[13px] text-zinc-500 leading-relaxed mb-4">
            {claim.description}
          </p>

          {/* State: live checking indicator */}
          <AnimatePresence mode="wait">
            {isChecking && (
              <motion.div
                key="checking"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                <CheckingIndicator />
              </motion.div>
            )}

            {/* State: verdict resolved with evidence */}
            {(claim.evidence || claim.screenshotDataUrl || claim.videoUrl || claim.transactionHash || claim.transactionAttempted) && !isChecking && (
              <motion.div
                key="evidence-section"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: 'easeOut', delay: 0.1 }}
              >
                <button
                  onClick={() => setExpanded((v) => !v)}
                  className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-zinc-600 hover:text-zinc-400 transition-colors duration-150"
                >
                  {expanded
                    ? <ChevronDown className="w-3 h-3" />
                    : <ChevronRight className="w-3 h-3" />
                  }
                  Evidence
                </button>

                <AnimatePresence>
                  {expanded && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.22, ease: 'easeOut' }}
                      className="overflow-hidden"
                    >
                      <div className="mt-3 bg-[#08080b] rounded-lg border border-cv-border/80 overflow-hidden">

                        {/* Agent session recording — primary evidence */}
                        {claim.videoUrl && (
                          <div className="border-b border-cv-border/60">
                            <div className="px-4 pt-3 pb-1 flex items-center gap-2">
                              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                              <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-600">
                                Agent Recording
                              </span>
                            </div>
                            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                            <video
                              src={claim.videoUrl}
                              controls
                              muted
                              playsInline
                              className="w-full max-h-64 bg-black"
                            />
                          </div>
                        )}

                        {/* Screenshot (shown when no video, or as fallback) */}
                        {claim.screenshotDataUrl && !claim.videoUrl && (
                          <div className="border-b border-cv-border/60">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={claim.screenshotDataUrl}
                              alt="Page screenshot"
                              className="w-full object-cover object-top max-h-48 opacity-80 hover:opacity-100 transition-opacity duration-200"
                            />
                          </div>
                        )}

                        {/* On-chain transaction evidence — label depends on receipt status */}
                        {claim.transactionHash && (() => {
                          const rs = claim.transactionReceiptStatus;
                          const isSuccess = rs === 'success';
                          const isRevert  = rs === 'reverted';
                          const isTimeout = rs === 'timeout';
                          const legacy    = rs === undefined;
                          const dotClass  = isSuccess ? 'bg-emerald-400' : isRevert ? 'bg-red-500' : 'bg-amber-400';
                          const titleClass = isSuccess
                            ? 'text-emerald-600'
                            : isRevert
                              ? 'text-red-500'
                              : 'text-amber-500';
                          const title =
                            isSuccess ? 'On-chain success'
                              : isRevert ? 'On-chain execution reverted'
                                : isTimeout ? 'Transaction submitted (receipt timeout)'
                                  : legacy ? 'Transaction submitted'
                                    : 'On-chain';
                          const sub =
                            isSuccess
                              ? 'Receipt status: success — BSC mainnet'
                              : isRevert
                                ? 'Receipt status: reverted — matches dApp "Transaction failed" when shown'
                                : isTimeout
                                  ? 'Could not confirm receipt in time — check BscScan for final status'
                                  : 'Receipt status not recorded (older scan) — verify on BscScan';
                          const linkClass = isSuccess
                            ? 'text-emerald-500 hover:text-emerald-400'
                            : 'text-zinc-400 hover:text-zinc-300';
                          return (
                          <div className="px-5 py-4 border-b border-cv-border/60">
                            <div className="flex items-center gap-2 mb-2">
                              <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
                              <span className={`text-[9px] font-bold uppercase tracking-widest ${titleClass}`}>
                                {title}
                              </span>
                            </div>
                            <p className="text-[11px] font-mono text-zinc-500 mb-2">
                              {sub}
                            </p>
                            <div className="flex items-center gap-3 flex-wrap">
                              <span className="text-[10px] font-mono text-zinc-600 bg-cv-elevated px-2 py-1 rounded truncate max-w-[260px]">
                                {claim.transactionHash}
                              </span>
                              <a
                                href={claim.transactionExplorerUrl ?? `https://bscscan.com/tx/${claim.transactionHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={`flex items-center gap-1.5 text-[10px] font-bold transition-colors duration-150 whitespace-nowrap ${linkClass}`}
                              >
                                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                                  <polyline points="15 3 21 3 21 9" />
                                  <line x1="10" y1="14" x2="21" y2="3" />
                                </svg>
                                View on BscScan
                              </a>
                            </div>
                          </div>
                          );
                        })()}

                        {/* Tx attempted but not broadcast (e.g. insufficient BNB for gas) */}
                        {!claim.transactionHash && claim.transactionAttempted && (
                          <div className="px-5 py-4 border-b border-cv-border/60">
                            <div className="flex items-center gap-2 mb-2">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                              <span className="text-[9px] font-bold uppercase tracking-widest text-amber-500">
                                Transaction attempted
                              </span>
                            </div>
                            <p className="text-[11px] font-mono text-zinc-500 mb-2">
                              eth_sendTransaction was called — feature builds real transactions.
                              Not broadcast (likely insufficient BNB for gas fees).
                            </p>
                            {claim.walletAddress && (
                              <div className="flex items-center gap-3 flex-wrap">
                                <span className="text-[10px] font-mono text-zinc-600 bg-cv-elevated px-2 py-1 rounded truncate max-w-[260px]">
                                  {claim.walletAddress}
                                </span>
                                <a
                                  href={`https://bscscan.com/txs?a=${claim.walletAddress}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1.5 text-[10px] font-bold text-amber-500 hover:text-amber-400 transition-colors duration-150 whitespace-nowrap"
                                >
                                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                                    <polyline points="15 3 21 3 21 9" />
                                    <line x1="10" y1="14" x2="21" y2="3" />
                                  </svg>
                                  View transactions on BscScan
                                </a>
                              </div>
                            )}
                          </div>
                        )}

                        {/* LLM reasoning */}
                        {claim.evidence && (
                          <div className="px-5 py-4">
                            <p className="text-[11px] font-mono text-zinc-500 leading-[1.75] whitespace-pre-wrap">
                              {claim.evidence}
                            </p>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}

            {/* State: revealed during analyzing (no verdict, not checking) */}
            {!claim.verdict && !claim.evidence && !isChecking && (
              <motion.div
                key="pending"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="flex items-center gap-2.5"
              >
                <span className="block w-1.5 h-1.5 rounded-full bg-zinc-700" />
                <span className="text-[11px] font-mono text-zinc-700">
                  Queued for verification
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

export function AuditClaimCardSkeleton({ index }: { index: number }) {
  return (
    <div className="border-l-[3px] border-l-[#26262e] pl-7 pr-7 py-6 mb-1.5 bg-cv-card rounded-xl shadow-card">
      <div className="flex items-start gap-6">
        <span
          className="font-mono text-[38px] font-bold leading-none flex-shrink-0 select-none w-12 text-right"
          style={{ color: '#1a1a22' }}
        >
          {String(index + 1).padStart(2, '0')}
        </span>
        <div className="flex-1 pt-2 space-y-3">
          <div className="h-4 w-56 rounded-md bg-cv-elevated animate-pulse" />
          <div className="h-3 w-80 rounded-md bg-cv-elevated animate-pulse" />
          <div className="h-3 w-52 rounded-md bg-cv-elevated animate-pulse opacity-50" />
        </div>
      </div>
    </div>
  );
}

// Entrance-animated wrapper used when a card first becomes visible
export function AnimatedClaimCard(props: AuditClaimCardProps & { delay?: number }) {
  const { delay = 0, ...cardProps } = props;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, delay, ease: 'easeOut' }}
    >
      <AuditClaimCard {...cardProps} />
    </motion.div>
  );
}
