import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type BadgeVariant =
  | 'in-progress'
  | 'complete'
  | 'larp'
  | 'verified'
  | 'untestable'
  | 'site-broken'
  | 'failed';

interface StatusBadgeProps {
  variant: BadgeVariant;
  label?: string;
  className?: string;
}

const BADGE_CONFIG: Record<
  BadgeVariant,
  { defaultLabel: string; className: string; spinner?: boolean }
> = {
  'in-progress': {
    defaultLabel: 'Verification In Progress',
    className:
      'bg-[#1c0a0a] text-red-400 border border-red-900/60 font-medium',
    spinner: true,
  },
  complete: {
    defaultLabel: 'Analysis Complete',
    className:
      'bg-[#071510] text-emerald-400 border border-emerald-900/50 font-medium',
  },
  larp: {
    defaultLabel: 'LARP',
    className:
      'bg-[#2a0808] text-red-400 border border-red-800/50 font-bold uppercase tracking-widest',
  },
  verified: {
    defaultLabel: 'Verified',
    className:
      'bg-[#071510] text-emerald-400 border border-emerald-800/50 font-bold uppercase tracking-widest',
  },
  untestable: {
    defaultLabel: 'Untestable',
    className:
      'bg-[#141418] text-zinc-500 border border-zinc-700/50 font-bold uppercase tracking-widest',
  },
  'site-broken': {
    defaultLabel: 'Site Broken',
    className:
      'bg-[#1a1000] text-amber-400 border border-amber-800/40 font-bold uppercase tracking-widest',
  },
  failed: {
    defaultLabel: 'Failed',
    className:
      'bg-[#1c0a0a] text-red-400 border border-red-800/50 font-bold uppercase tracking-widest',
  },
};

export function StatusBadge({ variant, label, className }: StatusBadgeProps) {
  const config = BADGE_CONFIG[variant];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-[3px] rounded-full text-[10px]',
        config.className,
        className,
      )}
    >
      {config.spinner && <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />}
      {label ?? config.defaultLabel}
    </span>
  );
}
