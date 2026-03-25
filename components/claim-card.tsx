import { StatusBadge } from './status-badge';
import type { BadgeVariant } from './status-badge';
import type { Claim, Verdict } from '@/lib/types';

interface ClaimCardProps {
  claim: Claim;
  index: number;
}

function verdictToBadge(verdict: Verdict): BadgeVariant {
  switch (verdict) {
    case 'VERIFIED':
      return 'verified';
    case 'LARP':
      return 'larp';
    case 'FAILED':
      return 'failed';
    case 'UNTESTABLE':
      return 'untestable';
    case 'SITE_BROKEN':
      return 'site-broken';
  }
}

export function ClaimCard({ claim, index }: ClaimCardProps) {
  return (
    <div className="pb-5 mb-5 border-b border-cv-border last:border-0 last:pb-0 last:mb-0">
      {/* Title row */}
      <div className="flex items-start justify-between gap-4 mb-2">
        <p className="text-xs font-bold uppercase tracking-wider text-white leading-snug">
          <span className="text-zinc-600 mr-2 font-mono">
            Claim {String(index + 1).padStart(2, '0')}:
          </span>
          {claim.title}
        </p>
        {claim.verdict && (
          <div className="flex-shrink-0">
            <StatusBadge variant={verdictToBadge(claim.verdict)} />
          </div>
        )}
      </div>

      {/* Evidence */}
      {claim.evidence && (
        <p className="text-xs text-zinc-500 leading-relaxed">{claim.evidence}</p>
      )}

      {/* Description fallback if no evidence yet */}
      {!claim.evidence && claim.description && (
        <p className="text-xs text-zinc-600 leading-relaxed">{claim.description}</p>
      )}
    </div>
  );
}
