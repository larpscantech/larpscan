'use client';

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Phase } from '@/lib/types';
import { useLocale } from '@/components/locale-provider';

interface PipelineStepperProps {
  phase: Phase;
  jobId?: string;
  elapsed?: number;
}

const STEPS: { id: Phase; label: string; description: string }[] = [
  { id: 'extracting', label: 'Extract',  description: 'Token metadata + social content' },
  { id: 'analyzing',  label: 'Analyze',  description: 'AI claim extraction'            },
  { id: 'verifying',  label: 'Verify',   description: 'Browser testing each claim'     },
  { id: 'reporting',  label: 'Report',   description: 'Assemble final report'          },
];

// Which step index is active for each phase
const PHASE_STEP: Record<Phase, number> = {
  idle:       -1,
  extracting:  0,
  analyzing:   1,
  verifying:   2,
  reporting:   3,
  complete:    4, // all done
};

const PHASE_STATUS: Partial<Record<Phase, string>> = {
  extracting: 'Fetching token metadata and social content...',
  analyzing:  'Running AI claim extraction model...',
  verifying:  'Launching browser sessions — testing each claim...',
  reporting:  'Assembling verification report...',
  complete:   'Verification complete',
};

function getStatus(stepIdx: number, phase: Phase): 'done' | 'active' | 'pending' {
  const activeStep = PHASE_STEP[phase];
  if (activeStep > stepIdx) return 'done';
  if (activeStep === stepIdx) return 'active';
  return 'pending';
}

export function PipelineStepper({ phase, jobId, elapsed = 0 }: PipelineStepperProps) {
  const { locale } = useLocale();
  const isZh = locale === 'zh-TW';
  const statusText = isZh
    ? ({
        idle: '',
        extracting: '正在抓取代幣資訊與社群內容...',
        analyzing: '正在執行 AI 宣稱提取模型...',
        verifying: '正在啟動瀏覽器工作階段並驗證每項宣稱...',
        reporting: '正在生成最終驗證報告...',
        complete: '驗證完成',
      } as const)[phase]
    : PHASE_STATUS[phase];
  const isComplete = phase === 'complete';
  const stepLabel = isZh
    ? ['提取', '分析', '驗證', '報告']
    : STEPS.map((s) => s.label);

  return (
    <div className="mb-8 rounded-sm border border-[#1c1c22] bg-[#09090d] overflow-hidden">
      {/* Animated progress bar at top */}
      <div className="h-[2px] w-full bg-[#111117] relative overflow-hidden">
        {!isComplete && phase !== 'idle' && (
          <div
            className="absolute inset-y-0 left-0 bg-gradient-to-r from-[#b91c1c]/80 to-[#dc2626]/60 transition-all duration-[3000ms] ease-in-out"
            style={{
              width: `${Math.min(95, ((PHASE_STEP[phase] + 1) / 4) * 100)}%`,
            }}
          />
        )}
        {isComplete && (
          <div className="absolute inset-0 bg-gradient-to-r from-emerald-700/60 to-emerald-600/40" />
        )}
      </div>

      <div className="px-6 pt-5 pb-4">
        {/* Steps row */}
        <div className="flex items-center mb-5">
          {STEPS.map((step, i) => {
            const status = getStatus(i, phase);
            const isLast = i === STEPS.length - 1;

            return (
              <div key={step.id} className="flex items-center flex-1 last:flex-none">
                <div className="flex items-center gap-3 flex-shrink-0">
                  {/* Node */}
                  <div
                    className={cn(
                      'w-7 h-7 rounded-sm flex items-center justify-center transition-all duration-500',
                      status === 'done' && 'bg-emerald-950/80 border border-emerald-800/60 shadow-[0_0_10px_rgba(22,163,74,0.2)]',
                      status === 'active' && 'bg-[#1c0808] border border-[#b91c1c]/60 shadow-[0_0_14px_rgba(185,28,28,0.3)]',
                      status === 'pending' && 'bg-[#111117] border border-[#1f1f27]',
                    )}
                  >
                    {status === 'done' ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" strokeWidth={2.5} />
                    ) : status === 'active' ? (
                      <span className="w-2.5 h-2.5 rounded-full bg-[#dc2626] animate-pulse" />
                    ) : (
                      <span className="w-2 h-2 rounded-full bg-zinc-800" />
                    )}
                  </div>

                  {/* Label stack */}
                  <div className="flex flex-col min-w-0">
                    <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-700 leading-none mb-0.5">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span
                      className={cn(
                        'text-[11px] font-bold uppercase tracking-wide leading-none transition-colors duration-500',
                        status === 'done'    && 'text-emerald-500',
                        status === 'active'  && 'text-[#f87171]',
                        status === 'pending' && 'text-zinc-700',
                      )}
                    >
                      {stepLabel[i]}
                    </span>
                  </div>
                </div>

                {/* Connector */}
                {!isLast && (
                  <div className="flex-1 mx-4 h-px relative overflow-hidden">
                    <div className="absolute inset-0 bg-[#1f1f27]" />
                    {status === 'done' && (
                      <div className="absolute inset-0 bg-emerald-700/40" />
                    )}
                    {status === 'active' && (
                      <div className="absolute inset-y-0 left-0 w-3/4 bg-gradient-to-r from-[#dc2626]/50 to-transparent animate-pulse" />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Bottom meta row */}
        <div className="flex items-center justify-between border-t border-[#1f1f27] pt-3">
          <div className="flex items-center gap-2">
            {!isComplete && phase !== 'idle' && (
              <div className="w-1.5 h-1.5 rounded-full bg-[#dc2626] animate-pulse flex-shrink-0" />
            )}
            {isComplete && (
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
            )}
              <span className="text-[11px] text-zinc-500">
              {statusText ?? ''}
            </span>
          </div>

          <div className="flex items-center gap-4">
            {elapsed > 0 && (
              <span className="font-mono text-[10px] text-zinc-600 tabular-nums">
                {isZh ? `已耗時 ${elapsed}s` : `${elapsed}s elapsed`}
              </span>
            )}
            {jobId && (
              <span className="font-mono text-[10px] text-zinc-700 hidden sm:inline">
                job/{jobId.slice(0, 8)}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
