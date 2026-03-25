'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

interface AgentLogsProps {
  logs: string[];
  isLive: boolean;
}

export function AgentLogs({ logs, isLive }: AgentLogsProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className="rounded-xl border border-cv-border bg-cv-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-cv-border">
        <div className="flex items-center gap-2">
          <span className="text-zinc-600 font-mono text-xs select-none">&gt;_</span>
          <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">
            Agent Logs
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <div
            className={cn(
              'w-1.5 h-1.5 rounded-full',
              isLive ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-600',
            )}
          />
          <span
            className={cn(
              'text-[10px] font-semibold uppercase tracking-widest',
              isLive ? 'text-emerald-500' : 'text-zinc-600',
            )}
          >
            {isLive ? 'Live' : 'Done'}
          </span>
        </div>
      </div>

      {/* Log content */}
      <div className="p-4 bg-cv-bg/50 min-h-[160px] max-h-[240px] overflow-y-auto">
        {logs.length === 0 ? (
          <p className="text-xs font-mono text-zinc-600">Waiting for agent...</p>
        ) : (
          <div className="space-y-1.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-600 mb-3">
              Live Updates
            </p>
            {logs.map((log, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-cv-red/60 font-mono text-xs select-none flex-shrink-0">
                  &gt;
                </span>
                <span
                  className={cn(
                    'font-mono text-xs leading-relaxed',
                    i === logs.length - 1 ? 'text-zinc-300' : 'text-zinc-500',
                  )}
                >
                  {log}
                </span>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </div>
  );
}
