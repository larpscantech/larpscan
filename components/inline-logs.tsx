'use client';

import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, Terminal } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface InlineLogsProps {
  logs: string[];
  isLive?: boolean;
}

function getLogStyle(log: string): { color: string; prefix: string } {
  if (log.startsWith('[ Claim') || log.includes('verdict →')) {
    return { color: 'text-[#f87171]', prefix: '>' };
  }
  if (log.toLowerCase().includes('complete') || log.toLowerCase().includes('found') || log.toLowerCase().includes('extracted') || log.toLowerCase().includes('identified')) {
    return { color: 'text-emerald-400/80', prefix: '→' };
  }
  if (log.includes('404') || log.toLowerCase().includes('blocked') || log.toLowerCase().includes('not found')) {
    return { color: 'text-amber-500/70', prefix: '!' };
  }
  if (log.toLowerCase().includes('larp') || log.toLowerCase().includes('0/')) {
    return { color: 'text-[#f87171]/70', prefix: '✗' };
  }
  return { color: 'text-zinc-500', prefix: '·' };
}

export function InlineLogs({ logs, isLive = false }: InlineLogsProps) {
  const [expanded, setExpanded] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Keep scroll pinned to bottom
  useEffect(() => {
    if (expanded && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs.length, expanded]);

  return (
    <div className="rounded-2xl border border-cv-border bg-cv-card shadow-card mb-8 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-6 py-4 hover:bg-cv-elevated/50 transition-colors group"
      >
        <div className="flex items-center gap-3">
          <Terminal className="w-3.5 h-3.5 text-zinc-600" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
            Agent Logs
          </span>
          {logs.length > 0 && (
            <span className="text-[9px] font-mono font-bold text-zinc-700 bg-cv-elevated border border-cv-border/80 rounded-full px-2 py-0.5">
              {logs.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {isLive && (
            <span className="flex items-center gap-1.5">
              <motion.span
                className="block w-1.5 h-1.5 rounded-full bg-emerald-500"
                animate={{ opacity: [1, 0.3, 1] }}
                transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
              />
              <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-500/80">
                Live
              </span>
            </span>
          )}
          {!isLive && logs.length > 0 && (
            <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-600">
              Done
            </span>
          )}
          {expanded
            ? <ChevronDown className="w-3.5 h-3.5 text-zinc-700 group-hover:text-zinc-500 transition-colors" />
            : <ChevronRight className="w-3.5 h-3.5 text-zinc-700 group-hover:text-zinc-500 transition-colors" />
          }
        </div>
      </button>

      {/* Log entries */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div
              className="max-h-56 overflow-y-auto border-t border-cv-border/50 scrollbar-thin px-6 py-4 space-y-1.5"
            >
              <AnimatePresence initial={false}>
                {logs.map((log, i) => {
                  const { color, prefix } = getLogStyle(log);
                  return (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.2, ease: 'easeOut' }}
                      className="flex items-start gap-3"
                    >
                      <span className={`font-mono text-[10px] flex-shrink-0 pt-px ${color} opacity-60 w-3 text-center`}>
                        {prefix}
                      </span>
                      <span className={`font-mono text-[11px] leading-relaxed ${color}`}>
                        {log}
                      </span>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
              {isLive && (
                <div className="flex items-center gap-3 pl-6">
                  <motion.span
                    className="font-mono text-[11px] text-zinc-700"
                    animate={{ opacity: [1, 0] }}
                    transition={{ duration: 0.8, repeat: Infinity, repeatType: 'reverse' }}
                  >
                    ▌
                  </motion.span>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
