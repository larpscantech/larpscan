'use client';

import { Search, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ContractInputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  isLoading: boolean;
  forceReverify: boolean;
  onForceReverifyChange: (v: boolean) => void;
}

export function ContractInput({
  value,
  onChange,
  onSubmit,
  isLoading,
  forceReverify,
  onForceReverifyChange,
}: ContractInputProps) {
  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !isLoading) onSubmit();
  }

  return (
    <div className="mb-6">
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600 pointer-events-none" />
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKey}
            disabled={isLoading}
            placeholder="Enter token contract address to verify..."
            className={cn(
              'w-full h-11 pl-11 pr-4 rounded-xl text-sm font-mono',
              'bg-cv-card border border-cv-border',
              'text-white placeholder:text-zinc-600',
              'focus:outline-none focus:border-cv-red/50 focus:ring-1 focus:ring-cv-red/20',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-all duration-150',
            )}
          />
        </div>
        <button
          onClick={onSubmit}
          disabled={isLoading || !value.trim()}
          className={cn(
            'h-11 px-6 rounded-xl text-xs font-bold uppercase tracking-widest',
            'bg-cv-card border border-cv-border text-zinc-300',
            'hover:border-zinc-600 hover:text-white hover:bg-cv-elevated',
            'disabled:opacity-40 disabled:cursor-not-allowed',
            'focus:outline-none focus:ring-1 focus:ring-cv-red/30',
            'transition-all duration-150 whitespace-nowrap',
            isLoading && 'border-cv-red/30 text-cv-red',
          )}
        >
          {isLoading ? (
            <span className="flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Verifying...
            </span>
          ) : (
            'Verify Token'
          )}
        </button>
      </div>

      <label className="mt-3 flex items-center gap-2.5 cursor-pointer w-fit group">
        <div
          onClick={() => onForceReverifyChange(!forceReverify)}
          className={cn(
            'w-4 h-4 rounded border flex items-center justify-center transition-all duration-150',
            forceReverify
              ? 'bg-cv-red/20 border-cv-red/60'
              : 'bg-cv-card border-cv-border group-hover:border-zinc-600',
          )}
        >
          {forceReverify && (
            <svg className="w-2.5 h-2.5 text-cv-red" viewBox="0 0 10 10" fill="none">
              <path
                d="M2 5L4 7L8 3"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </div>
        <span className="text-xs text-zinc-500 group-hover:text-zinc-400 transition-colors uppercase tracking-wider">
          Force Reverify
        </span>
      </label>
    </div>
  );
}
