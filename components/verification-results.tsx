import { Download, Flag, Loader2 } from 'lucide-react';
import { ClaimCard } from './claim-card';
import type { Claim, PipelineStage } from '@/lib/types';

interface VerificationResultsProps {
  claims: Claim[];
  isLoading: boolean;
  stage: PipelineStage;
}

export function VerificationResults({
  claims,
  isLoading,
  stage,
}: VerificationResultsProps) {
  const isVerifying = stage === 'verifying';
  const hasResults = claims.length > 0 && !isLoading;

  return (
    <div className="rounded-xl border border-cv-border bg-cv-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-cv-border">
        <div className="flex items-center gap-2">
          <span
            className={
              hasResults ? 'w-1.5 h-1.5 rounded-full bg-cv-red flex-shrink-0' : 'w-1.5 h-1.5 rounded-full bg-zinc-600 flex-shrink-0'
            }
          />
          <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">
            2. Verification Results
          </p>
        </div>
        {hasResults && (
          <div className="flex items-center gap-3">
            <button className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300 transition-colors">
              <Flag className="w-3 h-3" />
              Report a Problem
            </button>
            <div className="w-px h-3.5 bg-cv-border" />
            <button className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300 transition-colors">
              <Download className="w-3 h-3" />
              Export
            </button>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-5">
        {isVerifying && (
          <div className="flex items-center gap-2 mb-4 text-xs text-zinc-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-cv-red" />
            <span>Verification is in progress. Live execution moved to queue workers.</span>
          </div>
        )}

        {isLoading || (!hasResults && !isVerifying) ? (
          <div className="rounded-lg border border-cv-border bg-cv-bg/50 p-5">
            <p className="text-xs font-semibold text-zinc-400 mb-1">No verification report yet.</p>
            <p className="text-xs text-zinc-600">
              {stage === 'idle'
                ? 'Submit a contract address to begin.'
                : 'Results will populate here automatically after queue processing completes.'}
            </p>
          </div>
        ) : (
          <div>
            {claims.map((claim, i) => (
              <ClaimCard key={claim.id} claim={claim} index={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
