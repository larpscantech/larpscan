import { cn } from '@/lib/utils';
import type { Claim } from '@/lib/types';

interface ExtractedClaimsProps {
  claims: Claim[];
  isLoading: boolean;
}

function ClaimPill({ claim, index }: { claim: Claim; index: number }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-cv-border bg-cv-elevated hover:border-zinc-600 transition-colors">
      <span className="text-xs font-bold font-mono text-cv-red flex-shrink-0">
        {String(index + 1).padStart(2, '0')}
      </span>
      <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300 leading-tight">
        {claim.title}
      </span>
    </div>
  );
}

function LoadingPill() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-cv-border bg-cv-elevated">
      <div className="w-4 h-3 rounded bg-cv-border animate-pulse flex-shrink-0" />
      <div className="h-3 w-40 rounded bg-cv-border animate-pulse" />
    </div>
  );
}

export function ExtractedClaims({ claims, isLoading }: ExtractedClaimsProps) {
  return (
    <div className="rounded-xl border border-cv-border bg-cv-card p-5">
      <div className="flex items-center gap-2 mb-4">
        <span
          className={cn(
            'w-1.5 h-1.5 rounded-full flex-shrink-0',
            claims.length > 0 ? 'bg-cv-red' : 'bg-zinc-600',
          )}
        />
        <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">
          1. Extracted Claims
        </p>
        {claims.length > 0 && (
          <span className="ml-auto text-[10px] font-mono text-zinc-600">
            {claims.length} found
          </span>
        )}
      </div>

      {isLoading ? (
        <div>
          <p className="text-xs text-zinc-600 mb-4">Claims are being prepared.</p>
          <div className="space-y-2">
            <LoadingPill />
            <LoadingPill />
          </div>
        </div>
      ) : claims.length === 0 ? (
        <p className="text-xs text-zinc-600">No valid product claims were found.</p>
      ) : (
        <div className="space-y-2">
          {claims.map((claim, i) => (
            <ClaimPill key={claim.id} claim={claim} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}
