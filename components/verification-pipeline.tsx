import { Loader2, MoveRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PipelineStage } from '@/lib/types';

interface VerificationPipelineProps {
  stage: PipelineStage;
  jobId?: string;
  estSeconds?: number;
  claimsVerified?: number;
  claimsTotal?: number;
}

const STAGE_CONFIG: Partial<
  Record<PipelineStage, { heading: string; subtext: string }>
> = {
  extracting: {
    heading: 'EXTRACTING TOKEN CLAIMS',
    subtext: 'Gathering token metadata and social claims before verification is queued.',
  },
  analyzing: {
    heading: 'ANALYZING CLAIMS',
    subtext: 'AI is processing extracted claims and preparing automated verification tests.',
  },
  verifying: {
    heading: 'VERIFICATION IN PROGRESS',
    subtext: 'Running automated tests against the live product. Blockchain state is being checked.',
  },
};

export function VerificationPipeline({
  stage,
  jobId,
  estSeconds,
  claimsVerified,
  claimsTotal,
}: VerificationPipelineProps) {
  const config = STAGE_CONFIG[stage];
  if (!config) return null;

  const isVerifying = stage === 'verifying';

  return (
    <div
      className={cn(
        'rounded-xl border px-5 py-4 mb-6',
        'bg-cv-red/5 border-cv-red/15',
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Loader2 className="w-4 h-4 text-cv-red animate-spin flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-white mb-0.5">
              {config.heading}
            </p>
            <p className="text-xs text-zinc-500">{config.subtext}</p>
          </div>
        </div>

        {isVerifying && estSeconds && (
          <div className="flex items-center gap-2.5 flex-shrink-0">
            <span className="text-xs font-mono text-zinc-400">
              ~{estSeconds}s
            </span>
            {claimsVerified !== undefined && claimsTotal !== undefined && (
              <span className="text-xs font-mono text-zinc-500">
                {claimsVerified}/{claimsTotal} claims
              </span>
            )}
            <span className="flex items-center gap-1 text-xs font-medium text-cv-red">
              Moved to Queue
              <MoveRight className="w-3 h-3" />
            </span>
          </div>
        )}
      </div>

      {jobId && (
        <p className="mt-2 ml-7 text-[10px] font-mono text-zinc-600">
          Job {jobId}
        </p>
      )}
    </div>
  );
}
