'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ArrowRight, RotateCcw, AlertCircle, Globe } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Navbar } from '@/components/navbar';
import { PipelineStepper } from '@/components/pipeline-stepper';
import { ProjectIdentityBar } from '@/components/project-identity-bar';
import { AuditClaimCard, AuditClaimCardSkeleton, AnimatedClaimCard } from '@/components/audit-claim-card';
import { InlineLogs } from '@/components/inline-logs';
import { RecentVerificationsTable } from '@/components/recent-verifications-table';
import { useLocale } from '@/components/locale-provider';
import { cn } from '@/lib/utils';
import type { Phase, TokenProject, Claim, Verdict, RecentVerification } from '@/lib/types';
import type { DbProject, DbClaim, DbClaimWithEvidence, DbVerificationRun } from '@/lib/db-types';

// ─── Type converters: DB rows → frontend display types ────────────────────────

function toTokenProject(p: DbProject): TokenProject {
  return {
    name:            p.name,
    ticker:          p.symbol,
    logoInitial:     p.name[0]?.toUpperCase() ?? 'T',
    website:         p.website  ?? '',
    xHandle:         p.twitter  ?? '',
    contractAddress: p.contract_address,
  };
}

const DB_STATUS_TO_VERDICT: Partial<Record<string, Verdict>> = {
  verified:   'VERIFIED',
  larp:       'LARP',
  untestable: 'UNTESTABLE',
  failed:     'FAILED',
};

function sanitizeFrontendEvidence(text?: string): string | undefined {
  if (!text) return undefined;
  const cleaned = text
    .replace(/(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError)\s*:\s*[^\n]{0,500}/gi, '')
    .replace(/Cannot read propert(?:y|ies) of (?:undefined|null)[^\n]{0,250}/gi, '')
    .replace(/\bstartsWith\b[^\n]{0,200}/gi, '')
    .replace(/JavaScript(?:\s+runtime)?\s+(?:error|crash)[^\n]{0,350}/gi, '')
    .replace(/JS (?:runtime )?(?:error|crash)[^\n]{0,350}/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
  return cleaned || undefined;
}

function toFrontendClaim(c: DbClaim | DbClaimWithEvidence): Claim {
  const withEvidence = c as DbClaimWithEvidence;
  // Cast to a wider type that includes dynamic JSON fields written by saveEvidence
  const evidenceData = withEvidence.evidence_items?.[0]?.data as Record<string, unknown> | null | undefined;

  return {
    id:               c.id,
    title:            c.claim,
    description:      c.pass_condition,
    verdict:          (c.status !== 'pending' && c.status !== 'checking')
                        ? DB_STATUS_TO_VERDICT[c.status]
                        : undefined,
    evidence:               sanitizeFrontendEvidence((evidenceData?.['reasoning'] as string | undefined) ?? undefined),
    screenshotDataUrl:      (evidenceData?.['screenshotDataUrl']      as string  | undefined) ?? undefined,
    videoUrl:               (evidenceData?.['videoUrl']               as string  | undefined) ?? undefined,
    transactionHash:        (evidenceData?.['transactionHash']        as string  | undefined) ?? undefined,
    transactionExplorerUrl: (evidenceData?.['transactionExplorerUrl'] as string  | undefined) ?? undefined,
    transactionReceiptStatus:
      (evidenceData?.['transactionReceiptStatus'] as Claim['transactionReceiptStatus']) ?? undefined,
    transactionAttempted:   (evidenceData?.['transactionAttempted']   as boolean | undefined) ?? undefined,
    walletAddress:          (evidenceData?.['walletAddress']          as string  | undefined) ?? undefined,
    blockerReason:          sanitizeFrontendEvidence((evidenceData?.['blockerReason'] as string | undefined) ?? undefined),
  };
}

// ─── API helpers with full console instrumentation ────────────────────────────

const TAG  = '%c[LARPSCAN]';
const STYLE = 'color:#dc2626;font-weight:bold';

async function apiPost<T extends Record<string, unknown>>(
  label: string,
  path:  string,
  body:  unknown,
): Promise<T> {
  const t0 = performance.now();
  console.group(`${TAG} POST ${label}`, STYLE);
  console.log('  → payload:', body);

  try {
    const res  = await fetch(path, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json() as T & { success: boolean; error?: string };
    const ms   = Math.round(performance.now() - t0);

    if (!data.success) {
      console.error(`  ✗ ${res.status} (${ms}ms) →`, data.error);
      throw new Error(data.error ?? 'Request failed');
    }

    console.log(`  ✓ ${res.status} (${ms}ms) →`, data);
    return data;
  } finally {
    console.groupEnd();
  }
}

async function apiGet<T extends Record<string, unknown>>(
  label: string,
  path:  string,
): Promise<T> {
  const t0 = performance.now();
  console.group(`${TAG} GET ${label}`, STYLE);
  console.log('  → url:', path);

  try {
    const res  = await fetch(path);
    const data = await res.json() as T & { success: boolean; error?: string };
    const ms   = Math.round(performance.now() - t0);

    if (!data.success) {
      console.error(`  ✗ ${res.status} (${ms}ms) →`, data.error);
      throw new Error(data.error ?? 'Request failed');
    }

    console.log(`  ✓ ${res.status} (${ms}ms) →`, data);
    return data;
  } finally {
    console.groupEnd();
  }
}

// ─── Section divider (animated label) ────────────────────────────────────────

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-4 mb-8">
      <AnimatePresence mode="wait">
        <motion.span
          key={label}
          initial={{ opacity: 0, y: -3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 3 }}
          transition={{ duration: 0.18 }}
          className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-600 whitespace-nowrap"
        >
          {label}
        </motion.span>
      </AnimatePresence>
      <div className="flex-1 h-px bg-gradient-to-r from-red-600/30 to-transparent" />
    </div>
  );
}

// ─── Input mode toggle ────────────────────────────────────────────────────────

type InputMode = 'contract' | 'website';

function InputModeToggle({ value, onChange }: { value: InputMode; onChange: (v: InputMode) => void }) {
  return (
    <div className="flex gap-0.5 p-1 rounded-sm bg-[#0a0a0d] border border-[#1c1c22]">
      {(['contract', 'website'] as const).map((mode) => (
        <button
          key={mode}
          onClick={() => onChange(mode)}
          className={cn(
            'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] rounded-sm transition-all duration-150 whitespace-nowrap flex items-center gap-1.5',
            value === mode
              ? 'bg-[#1a0707] text-[#f87171] border border-[#b91c1c]/30'
              : 'text-zinc-600 hover:text-zinc-400',
          )}
        >
          {mode === 'contract' ? (
            <><span className="font-mono text-[9px]">0x</span> CA</>
          ) : (
            <><Globe className="w-2.5 h-2.5" /> URL</>
          )}
        </button>
      ))}
    </div>
  );
}

// ─── Contract input row ───────────────────────────────────────────────────────

function ContractRow({
  value, onChange, onSubmit, isLoading,
  forceReverify, onForceReverifyChange,
  inputMode, onInputModeChange,
}: {
  value: string; onChange: (v: string) => void; onSubmit: () => void; isLoading: boolean;
  forceReverify: boolean; onForceReverifyChange: (v: boolean) => void;
  inputMode: InputMode; onInputModeChange: (v: InputMode) => void;
}) {
  const { locale } = useLocale();
  const isZh = locale === 'zh-TW';
  const isUrl = inputMode === 'website';

  const placeholder = isUrl
    ? 'https://yourproject.io'
    : isZh ? '輸入代幣合約地址...' : 'Enter token contract address...';

  return (
    <div className="mb-12">
      <div className="flex items-center gap-3 mb-3">
        <InputModeToggle value={inputMode} onChange={onInputModeChange} />
        <div className="flex-1 relative">
          {isUrl ? (
            <Globe className="absolute left-3.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-700 pointer-events-none" />
          ) : (
            <span className="absolute left-4 top-1/2 -translate-y-1/2 font-mono text-xs text-zinc-700 pointer-events-none select-none">$</span>
          )}
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !isLoading && onSubmit()}
            disabled={isLoading}
            placeholder={placeholder}
            className={cn(
              'w-full h-12 pl-9 pr-4 rounded-sm text-sm font-mono',
              'bg-[#09090d] border border-[#1c1c22]',
              'text-white placeholder:text-zinc-700',
              'focus:outline-none focus:border-[#b91c1c]/50 focus:ring-2 focus:ring-[#dc2626]/10',
              'disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150',
            )}
          />
        </div>
        <button
          onClick={onSubmit}
          disabled={isLoading || !value.trim()}
          className={cn(
            'h-12 px-6 rounded-sm flex items-center gap-2.5 flex-shrink-0',
            'text-[11px] font-semibold uppercase tracking-[0.18em] whitespace-nowrap',
            'bg-[#dc2626] text-white',
            'hover:bg-[#b91c1c]',
            'disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none',
            'focus:outline-none focus:ring-2 focus:ring-[#dc2626]/40 transition-all duration-150',
          )}
        >
          {isLoading ? (
            <>
              <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              {isZh ? '掃描中...' : 'Scanning...'}
            </>
          ) : (
            <>{isZh ? '驗證' : 'Verify'} <ArrowRight className="w-3.5 h-3.5" /></>
          )}
        </button>
      </div>

      <label
        onClick={() => onForceReverifyChange(!forceReverify)}
        className="flex items-center gap-2.5 cursor-pointer w-fit group ml-1 select-none"
      >
        <div
          className={cn(
            'w-4 h-4 rounded border flex items-center justify-center transition-all shrink-0',
            forceReverify ? 'bg-[#1c0808] border-[#b91c1c]/50' : 'border-cv-border group-hover:border-zinc-600',
          )}
        >
          {forceReverify && (
            <svg className="w-2.5 h-2.5 text-[#dc2626]" viewBox="0 0 8 8" fill="none">
              <path d="M1 4L3 6L7 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600 group-hover:text-zinc-500 transition-colors">
          {isZh ? '強制重新驗證' : 'Force Reverify'}
        </span>
      </label>
    </div>
  );
}

// ─── Error banner ─────────────────────────────────────────────────────────────

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const { locale } = useLocale();
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2 }}
      className="flex items-start gap-3 px-5 py-4 rounded-sm border border-red-900/50 bg-[#1c0808] mb-6"
    >
      <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
      <p className="text-[12px] text-red-300 leading-relaxed flex-1 font-mono">{message}</p>
      <button onClick={onDismiss} className="text-red-600 hover:text-red-400 text-[10px] font-bold uppercase tracking-widest flex-shrink-0">
        {locale === 'zh-TW' ? '關閉' : 'Dismiss'}
      </button>
    </motion.div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  const { locale } = useLocale();
  const isZh = locale === 'zh-TW';
  return (
    <div className="py-20 text-center mb-12">
      <div className="inline-flex items-center justify-center w-14 h-14 rounded-sm border border-[#1c1c22] bg-[#09090d] mb-6">
        <div className="w-5 h-5 rounded-md border-2 border-zinc-700" />
      </div>
      <p className="text-[11px] font-bold uppercase tracking-widest text-zinc-600 mb-3">
        {isZh ? '目前沒有執行中的驗證' : 'No active verification'}
      </p>
      <p className="text-xs text-zinc-700 max-w-xs mx-auto leading-relaxed">
        {isZh ? (
          <>
            貼上合約地址並點擊 <span className="text-zinc-500 font-mono">驗證 →</span>，
            啟動 AI 驅動的產品審核流程。
          </>
        ) : (
          <>
            Paste a contract address and click{' '}
            <span className="text-zinc-500 font-mono">Verify →</span> to run an AI-powered
            product audit against the live project.
          </>
        )}
      </p>
    </div>
  );
}

// ─── Claims section ───────────────────────────────────────────────────────────

interface ClaimsSectionProps {
  phase: Phase;
  claims: Claim[];
  visibleClaimsCount: number;
  resolvedResultsCount: number;
  checkingClaimIndex: number;
}

function ClaimsSection({
  phase, claims, visibleClaimsCount, resolvedResultsCount, checkingClaimIndex,
}: ClaimsSectionProps) {
  const skeletonCount = 3;

  if (phase === 'extracting') {
    return (
      <div className="space-y-1">
        {Array.from({ length: skeletonCount }, (_, i) => (
          <AuditClaimCardSkeleton key={i} index={i} />
        ))}
      </div>
    );
  }

  if (phase === 'analyzing') {
    return (
      <div className="space-y-1">
        {claims.slice(0, visibleClaimsCount).map((claim, i) => (
          <AnimatedClaimCard
            key={claim.id}
            claim={{ ...claim, verdict: undefined, evidence: undefined }}
            index={i}
            defaultExpanded={false}
          />
        ))}
        {Array.from(
          { length: Math.max(0, skeletonCount - visibleClaimsCount) },
          (_, i) => <AuditClaimCardSkeleton key={`sk-${i}`} index={visibleClaimsCount + i} />,
        )}
      </div>
    );
  }

  if (phase === 'verifying') {
    return (
      <div className="space-y-1">
        {claims.map((claim, i) => {
          const stripped = {
            ...claim,
            verdict: undefined,
            evidence: undefined,
            screenshotDataUrl: undefined,
            videoUrl: undefined,
            transactionHash: undefined,
            transactionExplorerUrl: undefined,
            transactionReceiptStatus: undefined as 'success' | 'reverted' | 'timeout' | undefined,
            transactionAttempted: undefined,
            walletAddress: undefined,
            blockerReason: undefined,
          };
          if (i === checkingClaimIndex) {
            return (
              <AuditClaimCard
                key={claim.id}
                claim={stripped}
                index={i}
                isChecking={true}
              />
            );
          }
          if (i < visibleClaimsCount) {
            return (
              <AuditClaimCard
                key={claim.id}
                claim={stripped}
                index={i}
                defaultExpanded={false}
              />
            );
          }
          return <AuditClaimCardSkeleton key={`sk-${i}`} index={i} />;
        })}
      </div>
    );
  }

  if (phase === 'reporting' || phase === 'complete') {
    return (
      <div className="space-y-1">
        {claims.map((claim, i) => (
          <AuditClaimCard key={claim.id} claim={claim} index={i} defaultExpanded={false} />
        ))}
      </div>
    );
  }

  return null;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { locale } = useLocale();
  const isZh = locale === 'zh-TW';
  const [entryAnimation, setEntryAnimation] = useState(false);
  const [entryChecked, setEntryChecked] = useState(false);
  const [pageEntered, setPageEntered] = useState(false);
  // ── Input state ─────────────────────────────────────────────────────────────
  const [input, setInput]               = useState('');
  const [forceReverify, setForceReverify] = useState(false);
  const [inputMode, setInputMode]       = useState<InputMode>('contract');

  // ── Pipeline state ──────────────────────────────────────────────────────────
  const [phase, setPhase]               = useState<Phase>('idle');
  const [elapsed, setElapsed]           = useState(0);
  const [displayedLogs, setDisplayedLogs] = useState<string[]>([]);
  const [apiError, setApiError]         = useState<string | null>(null);

  // ── Real data from backend ──────────────────────────────────────────────────
  const [realProject, setRealProject]   = useState<DbProject | null>(null);
  const [realClaims, setRealClaims]     = useState<DbClaim[]>([]);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);

  // ── Reveal animation state ───────────────────────────────────────────────────
  const [projectLoaded, setProjectLoaded]               = useState(false);
  const [visibleClaimsCount, setVisibleClaimsCount]     = useState(0);
  const [resolvedResultsCount, setResolvedResultsCount] = useState(0);
  const [checkingClaimIndex, setCheckingClaimIndex]     = useState(-1);

  const runIdRef  = useRef(0);
  // Kept in sync with `phase` so effects with stable deps can read the latest phase
  // without adding `phase` to their dependency array (avoids spurious re-runs).
  const phaseRef  = useRef<Phase>('idle');
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // ── Recent scans (real data from DB) ─────────────────────────────────────────
  const [recentScans, setRecentScans] = useState<RecentVerification[]>([]);

  const fetchRecentScans = useCallback(async () => {
    try {
      const res  = await fetch('/api/runs/recent');
      const data = await res.json() as { success: boolean; runs?: RecentVerification[] };
      if (data.success && data.runs) {
        setRecentScans(data.runs);
        console.log(`${TAG} Recent scans loaded: ${data.runs.length}`, STYLE);
      }
    } catch (e) {
      console.warn(`${TAG} Failed to load recent scans:`, STYLE, e);
    }
  }, []);

  // Load on mount and after each completed run
  useEffect(() => { void fetchRecentScans(); }, [fetchRecentScans]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const shouldAnimate = window.sessionStorage.getItem('larpscan_dashboard_entry') === '1';
    if (shouldAnimate) {
      setEntryAnimation(true);
      window.sessionStorage.removeItem('larpscan_dashboard_entry');
    }
    setEntryChecked(true);

    // ── Restore CA from URL on refresh / direct link ─────────────────────────
    // If the URL has ?ca=0x..., prefill the input. The debounced active-run
    // check further below will auto-join the run if it's still in progress.
    const urlCa = new URLSearchParams(window.location.search).get('ca')?.trim();
    if (urlCa && /^0x[0-9a-fA-F]{40,}$/i.test(urlCa)) {
      setInput(urlCa);
    }

    // ── Restore website URL from ?url= on refresh / direct link ──────────────
    const urlWebsite = new URLSearchParams(window.location.search).get('url')?.trim();
    if (urlWebsite && /^https?:\/\//i.test(urlWebsite)) {
      setInputMode('website');
      setInput(urlWebsite);
    }

    // ── Instantly restore run from ?runId= on refresh / direct link ──────────
    // If the URL has ?runId=, skip the debounce+orchestrate path entirely:
    // fetch the run status directly and restore the UI state in <1s.
    const urlRunId = new URLSearchParams(window.location.search).get('runId')?.trim();
    if (urlRunId && /^[0-9a-f-]{36}$/i.test(urlRunId)) {
      void (async () => {
        try {
          const res = await fetch(`/api/verify/status?runId=${urlRunId}`);
          if (!res.ok) return;
          const data = await res.json() as {
            run:     DbVerificationRun;
            claims:  DbClaimWithEvidence[];
            logs:    { message: string }[];
            project: DbProject | null;
          };
          // Only restore if in-flight or recently completed
          if (!data.run) return;
          if (data.project) setRealProject(data.project);
          setCurrentRunId(urlRunId);
          setRealClaims(data.claims ?? []);
          setVisibleClaimsCount(data.claims?.length ?? 0);
          setProjectLoaded(true);

          if (data.run.status === 'complete') {
            setResolvedResultsCount(data.claims?.length ?? 0);
            setCheckingClaimIndex(-1);
            setPhase('complete');
            setDisplayedLogs(['Restored from previous run ✓']);
          } else {
            // Still verifying — restore verifying phase and let poll loop take over
            setPhase('verifying');
            setCheckingClaimIndex(0);
            setDisplayedLogs([`Reconnected to run ${urlRunId.slice(0, 8)}…`]);
          }
        } catch {
          // Non-fatal — user can click verify manually
        }
      })();
    }
  }, []);

  useEffect(() => {
    if (!entryChecked) return;
    const t = window.setTimeout(() => setPageEntered(true), 40);
    return () => window.clearTimeout(t);
  }, [entryChecked, locale]);

  // ── Playwright / E2E test hook ───────────────────────────────────────────────
  // Expose window functions so automated tests can set the input and trigger
  // verification without fighting React's controlled-input event system.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window as typeof window & {
      __larpscanSetAddress?: (addr: string) => void;
    };
    const setAddress = (addr: string) => {
      setInput(addr);
    };
    w.__larpscanSetAddress = setAddress;
    return () => {
      delete w.__larpscanSetAddress;
    };
  }, []);

  // ── Debounced active-run check ────────────────────────────────────────────
  // When the user types a valid-looking CA or URL (or one is restored from the URL),
  // we wait 600 ms then ask the server if there's already an active run for it.
  // Active run  → auto-teleport (join via startVerification → orchestrate join path).
  // Completed   → load result directly from /api/verify/status (skip orchestrate).
  // Idle phases only to avoid interrupting an in-progress scan.
  useEffect(() => {
    const trimmed = input.trim();
    const isCA  = /^0x[0-9a-fA-F]{40,}$/i.test(trimmed);
    const isURL = /^https?:\/\/.+/i.test(trimmed);
    if (!trimmed || (!isCA && !isURL)) return;
    if (phaseRef.current !== 'idle') return;

    const timer = window.setTimeout(async () => {
      if (phaseRef.current !== 'idle') return;
      try {
        const param = isCA
          ? `ca=${encodeURIComponent(trimmed)}`
          : `url=${encodeURIComponent(trimmed)}`;
        const res = await fetch(`/api/verify/active?${param}`);
        if (!res.ok) return;
        const data = await res.json() as {
          hasActiveRun:    boolean;
          hasCompletedRun: boolean;
          runId:           string | null;
          runStatus:       string | null;
        };
        if (phaseRef.current !== 'idle') return;

        if (data.hasActiveRun && data.runId) {
          // In-flight run — join through the normal pipeline
          console.log(`[dashboard] Auto-teleporting to active run ${data.runId} for ${isCA ? 'CA' : 'URL'} ${trimmed}`);
          void startVerification(trimmed);
          return;
        }

        if (data.hasCompletedRun && data.runId) {
          // Completed run — load directly from status, bypassing orchestrate
          console.log(`[dashboard] Auto-loading completed run ${data.runId} for ${isCA ? 'CA' : 'URL'} ${trimmed}`);
          try {
            const statusRes = await fetch(`/api/verify/status?runId=${data.runId}`);
            if (!statusRes.ok || phaseRef.current !== 'idle') return;
            const statusData = await statusRes.json() as {
              run:     DbVerificationRun;
              claims:  DbClaimWithEvidence[];
              logs:    { message: string }[];
              project: DbProject | null;
            };
            if (phaseRef.current !== 'idle') return;

            if (statusData.project) setRealProject(statusData.project);
            setCurrentRunId(data.runId);
            setRealClaims(statusData.claims);
            setVisibleClaimsCount(statusData.claims.length);
            setResolvedResultsCount(statusData.claims.length);
            setCheckingClaimIndex(-1);
            setProjectLoaded(true);
            setPhase('complete');
            setDisplayedLogs(['Restored from previous run ✓']);

            // Push to URL
            if (typeof window !== 'undefined') {
              const url = new URL(window.location.href);
              if (isCA) {
                url.searchParams.set('ca', trimmed);
                url.searchParams.delete('url');
              } else {
                url.searchParams.set('url', trimmed);
                url.searchParams.delete('ca');
              }
              window.history.replaceState({}, '', url.toString());
            }
          } catch {
            // Non-fatal — user can click verify manually
          }
        }
      } catch {
        // Non-fatal — user can still click verify manually
      }
    }, 600);

    return () => window.clearTimeout(timer);
  // `startVerification` is stable (useCallback). `input` changes drive this effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  // ── Elapsed timer ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase === 'idle')     { setElapsed(0); return; }
    if (phase === 'complete') { return; }
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const addLog = useCallback((message: string) => {
    setDisplayedLogs((prev) => [...prev, message]);
  }, []);

  // ── Shared polling loop — used by both startVerification and instant load ────
  const pollRunToCompletion = useCallback(async (
    runId: string,
    alive: () => boolean,
    sleep: (ms: number) => Promise<void>,
  ) => {
    setPhase('verifying');
    setCheckingClaimIndex(0);

    let rotateIdx = 0;
    const rotatePeriodMs = 5_000;
    const rotateTimer = setInterval(() => {
      if (!alive()) { clearInterval(rotateTimer); return; }
      rotateIdx = (rotateIdx + 1) % Math.max(1, visibleClaimsCount || 3);
      setCheckingClaimIndex(rotateIdx);
    }, rotatePeriodMs);

    const maxPollMs = 10 * 60 * 1000;
    const pollStart = Date.now();
    let finalStatus: { claims: DbClaimWithEvidence[]; logs: { message: string }[] } | null = null;
    let dispatchRetried = false;

    while (alive() && Date.now() - pollStart < maxPollMs) {
      await sleep(5_000);
      if (!alive()) break;

      try {
        const statusRes = await apiGet<{
          run:    DbVerificationRun;
          claims: DbClaimWithEvidence[];
          logs:   { message: string }[];
        }>('/api/verify/status', `/api/verify/status?runId=${runId}`);

        // Update claims as they arrive so the UI shows progress
        if (statusRes.claims.length > 0) {
          setRealClaims(statusRes.claims);
          setVisibleClaimsCount(statusRes.claims.length);
        }

        // Sync server logs into the UI
        if (statusRes.logs?.length) {
          setDisplayedLogs(statusRes.logs.map((l) => l.message));
        }

        // If the run is already terminal (complete/failed), we're done
        if (statusRes.run.status === 'complete' || statusRes.run.status === 'failed') {
          finalStatus = statusRes;
          console.log(`${TAG} Run is ${statusRes.run.status} — done polling`, STYLE);
          break;
        }

        const allClaimsResolved = statusRes.claims.length > 0 &&
          statusRes.claims.every((c) => c.status !== 'pending' && c.status !== 'checking');

        if (allClaimsResolved) {
          finalStatus = statusRes;
          console.log(`${TAG} All ${statusRes.claims.length} claims resolved`, STYLE);
          break;
        }

        // Safety: if all claims are still 'pending' after 30s, dispatch may have
        // failed (e.g. user closed tab before /api/verify/run was called).
        // Re-trigger dispatch to unstick the run.
        const allPending = statusRes.claims.length > 0 &&
          statusRes.claims.every((c) => c.status === 'pending');
        const pollAge = Date.now() - pollStart;
        if (allPending && pollAge > 30_000 && !dispatchRetried) {
          dispatchRetried = true;
          console.warn(`${TAG} All claims still pending after 30s — re-dispatching`, STYLE);
          fetch('/api/verify/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runId }),
          }).catch(() => {});
        }

        const resolved = statusRes.claims.filter((c) => c.status !== 'pending' && c.status !== 'checking').length;
        console.log(`${TAG} Poll: ${resolved}/${statusRes.claims.length} claims done`, STYLE);
      } catch (e) {
        console.warn(`${TAG} Status poll failed (retrying):`, STYLE, e);
      }
    }

    clearInterval(rotateTimer);
    setCheckingClaimIndex(-1);

    if (!finalStatus && alive()) {
      console.warn(`${TAG} Poll timed out — fetching latest partial results`, STYLE);
      addLog('Some claims are still processing — showing available results');
      try {
        const partialRes = await apiGet<{
          run:    DbVerificationRun;
          claims: DbClaimWithEvidence[];
          logs:   { message: string }[];
        }>('/api/verify/status', `/api/verify/status?runId=${runId}`);
        finalStatus = partialRes;
      } catch { /* use whatever we have */ }
    }

    if (finalStatus) {
      setRealClaims(finalStatus.claims);
      setVisibleClaimsCount(finalStatus.claims.length);
      for (let i = 0; i < finalStatus.claims.length; i++) {
        if (!alive()) break;
        await sleep(350);
        setResolvedResultsCount(i + 1);
        const c = finalStatus.claims[i];
        const label = (c.status === 'pending' || c.status === 'checking')
          ? 'PROCESSING'
          : c.status.toUpperCase();
        addLog(`Claim ${String(i + 1).padStart(2, '0')} → ${label}`);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addLog, visibleClaimsCount]);

  // ── Core verification pipeline ────────────────────────────────────────────────
  // Single API call to /api/verify/orchestrate handles everything server-side:
  // discover → dedup → scrape → extract → dispatch claim workers.
  // The client just calls orchestrate, then polls for results.
  const startVerification = useCallback(async (overrideAddress?: string) => {
    const myRunId = ++runIdRef.current;
    const alive   = () => runIdRef.current === myRunId;
    const sleep   = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const address = (overrideAddress ?? input).trim();

    // ── Hard reset all state ──────────────────────────────────────────────────
    setDisplayedLogs([]);
    setRealProject(null);
    setRealClaims([]);
    setCurrentRunId(null);
    setApiError(null);
    setProjectLoaded(false);
    setVisibleClaimsCount(0);
    setResolvedResultsCount(0);
    setCheckingClaimIndex(-1);
    setElapsed(0);

    console.group(`${TAG} ══ Verification run started ══`, STYLE);
    console.log('  contract :', address);
    console.log('  timestamp:', new Date().toISOString());

    const isUrlInput = /^https?:\/\//i.test(address);

    // ── PHASE 1 — Call orchestrate (server does discover + scrape + extract + dispatch)
    setPhase('extracting');
    addLog('Initializing verification job...');
    if (isUrlInput) {
      addLog(`Scanning website: ${address}`);
    } else {
      addLog(`Resolving contract: ${address.slice(0, 10)}...`);
    }

    let orchResult: { runId: string; project: DbProject; status: 'started' | 'joined' | 'complete' };
    try {
      orchResult = await apiPost<{
        runId: string;
        project: DbProject;
        status: 'started' | 'joined' | 'complete';
      }>(
        '/api/verify/orchestrate',
        '/api/verify/orchestrate',
        isUrlInput
          ? { websiteUrl: address, forceReverify }
          : { contractAddress: address, forceReverify },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Verification failed';
      console.error(`${TAG} orchestrate failed:`, STYLE, msg);
      addLog(`✗ Error: ${msg}`);
      setApiError(msg);
      setPhase('idle');
      console.groupEnd();
      return;
    }

    if (!alive()) { console.groupEnd(); return; }

    const project = orchResult.project;
    const runId = orchResult.runId;

    setRealProject(project);
    setProjectLoaded(true);
    setCurrentRunId(runId);

    // ── Push CA/URL + runId to URL so a refresh auto-reconnects instantly ────
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (isUrlInput) {
        url.searchParams.set('url', address);
        url.searchParams.delete('ca');
      } else {
        url.searchParams.set('ca', address);
        url.searchParams.delete('url');
      }
      url.searchParams.set('runId', runId);
      window.history.replaceState({}, '', url.toString());
    }

    addLog(`Token: ${project.name} (${project.symbol})`);
    if (project.website) addLog(`Website: ${project.website}`);
    addLog(`Run ID: ${runId.slice(0, 8)}...`);

    // ── Handle orchestrate response status ────────────────────────────────────
    if (orchResult.status === 'complete') {
      // Cached completed run — load instantly
      addLog('Existing completed run found — loading cached result');
      try {
        const statusRes = await apiGet<{
          run: DbVerificationRun;
          claims: DbClaimWithEvidence[];
          logs: { message: string }[];
        }>('/api/verify/status', `/api/verify/status?runId=${runId}`);

        if (!alive()) { console.groupEnd(); return; }

        setRealClaims(statusRes.claims);
        setVisibleClaimsCount(statusRes.claims.length);
        setResolvedResultsCount(statusRes.claims.length);
        setCheckingClaimIndex(-1);
        setPhase('complete');
        addLog('Cached verification loaded ✓');
        void fetchRecentScans();
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to load cached run';
        addLog(`✗ ${msg}`);
        setApiError(msg);
        setPhase('idle');
      }
        console.groupEnd();
        return;
    }

    if (orchResult.status === 'joined') {
      addLog('Joining existing verification in progress...');
    } else {
      addLog('Server is processing — discovering, scraping, extracting claims...');

      // Orchestrate created the run + claims but did NOT dispatch claim workers
      // (fire-and-forget fetches die on Vercel when the Lambda returns).
      // Call /api/verify/run in a separate request to dispatch claims properly.
      try {
        await apiPost<{ runId: string; results: unknown[] }>(
          '/api/verify/run',
          '/api/verify/run',
          { runId },
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Dispatch failed';
        console.warn(`${TAG} verify/run dispatch failed (claims may still be pending):`, STYLE, msg);
        addLog(`Warning: claim dispatch issue — ${msg}`);
      }
    }

    // ── PHASE 2 — Poll until all claims are done ──────────────────────────────
    setPhase('analyzing');
    addLog('Waiting for claim extraction and verification...');

    // Give the server a moment to dispatch and start processing claims.
    // When joining an already-running session we skip the warm-up wait and
    // immediately detect the real phase from the live run state.
    if (orchResult.status === 'joined') {
      // Fetch the current run state so we can set the correct phase immediately.
      try {
        const liveStatus = await apiGet<{
          run: DbVerificationRun;
          claims: DbClaimWithEvidence[];
          logs: { message: string }[];
        }>('/api/verify/status', `/api/verify/status?runId=${runId}`);

        if (alive()) {
          const allDone = liveStatus.claims.every(
            (c) => c.status !== 'pending' && c.status !== 'checking',
          );
          if (allDone && liveStatus.run?.status === 'complete') {
            setRealClaims(liveStatus.claims);
            setVisibleClaimsCount(liveStatus.claims.length);
            setResolvedResultsCount(liveStatus.claims.length);
            setCheckingClaimIndex(-1);
            setPhase('complete');
            addLog('Verification complete (joined finished run) ✓');
            void fetchRecentScans();
            console.groupEnd();
            return;
          }

          if (liveStatus.claims.length > 0) {
            setRealClaims(liveStatus.claims);
            setVisibleClaimsCount(liveStatus.claims.length);
            const resolved = liveStatus.claims.filter(
              (c) => c.status !== 'pending' && c.status !== 'checking',
            ).length;
            setResolvedResultsCount(resolved);
          }
        }
      } catch {
        // Non-fatal — fall through to normal polling
      }
    } else {
      // Give the server a moment to dispatch and start processing claims
      await sleep(3_000);
      if (!alive()) { console.groupEnd(); return; }
    }

    await pollRunToCompletion(runId, alive, sleep);

    if (!alive()) { console.groupEnd(); return; }

    // ── COMPLETE ──────────────────────────────────────────────────────────────
    setPhase('reporting');
    await sleep(400);
    addLog('Assembling verification report...');
    await sleep(600);

        if (!alive()) { console.groupEnd(); return; }

    setPhase('complete');
    addLog('Verification run complete ✓');
    void fetchRecentScans();

    console.log(`${TAG} ══ Run complete ══`, STYLE);
    console.groupEnd();
  }, [input, forceReverify, addLog, fetchRecentScans, pollRunToCompletion]);

  // ── Reset ──────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(() => {
    if (!input.trim() || (phase !== 'idle' && phase !== 'complete')) return;
    startVerification();
  }, [input, phase, startVerification]);

  // ── Load a previous scan from the recent-scans table ───────────────────────
  // Completed scans: load instantly from DB (no re-discovery, no re-scraping).
  // In-progress scans: join the polling loop.
  const handleSelectRecentScan = useCallback(async (v: import('@/lib/types').RecentVerification) => {
    if (phase !== 'idle' && phase !== 'complete') return;

    const myRunId = ++runIdRef.current;
    const alive   = () => runIdRef.current === myRunId;
    const sleep   = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    // URL-mode projects use a synthetic contract_address like "url:hostname".
    // Restore the actual website URL in that case and switch to URL mode.
    const isUrlProject = v.project.contractAddress.startsWith('url:');
    if (isUrlProject) {
      const websiteToRestore = v.project.website || `https://${v.project.contractAddress.slice(4)}`;
      setInputMode('website');
      setInput(websiteToRestore);
    } else {
      setInputMode('contract');
      setInput(v.project.contractAddress);
    }

    // ── Hard reset ──────────────────────────────────────────────────────────
    setDisplayedLogs([]);
    setRealProject(null);
    setRealClaims([]);
    setCurrentRunId(v.id);
    setApiError(null);
    setProjectLoaded(false);
    setVisibleClaimsCount(0);
    setResolvedResultsCount(0);
    setCheckingClaimIndex(-1);
    setElapsed(0);

    // Build a minimal project object from the recent scan data
    const projectStub: DbProject = {
      id: '', contract_address: v.project.contractAddress,
      name: v.project.name, symbol: v.project.ticker,
      website: v.project.website, twitter: v.project.xHandle,
      logo_url: null, description: null, chain: 'bsc', created_at: '',
    };
    setRealProject(projectStub);
    setProjectLoaded(true);

    addLog(`Loading verification for ${v.project.name}...`);

    if (v.status === 'complete') {
      // ── Instant load: fetch cached results directly ──────────────────────
      setPhase('extracting');
      try {
        const statusRes = await apiGet<{
          run: DbVerificationRun;
          claims: DbClaimWithEvidence[];
          logs: { message: string }[];
        }>('/api/verify/status', `/api/verify/status?runId=${v.id}`);

        if (!alive()) return;

        setRealClaims(statusRes.claims);
        setVisibleClaimsCount(statusRes.claims.length);
        setResolvedResultsCount(statusRes.claims.length);
        setCheckingClaimIndex(-1);
        setPhase('complete');
        addLog('Verification loaded ✓');
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to load verification';
        addLog(`✗ ${msg}`);
        setApiError(msg);
        setPhase('idle');
      }
    } else {
      // ── In-progress: join the polling loop ────────────────────────────────
      addLog('Verification in progress — joining...');
      await pollRunToCompletion(v.id, alive, sleep);

      if (!alive()) return;

    setPhase('complete');
    addLog('Verification run complete ✓');
    void fetchRecentScans();
    }
  }, [phase, addLog, fetchRecentScans, pollRunToCompletion]);

  const handleReset = useCallback(() => {
    console.log(`${TAG} Reset triggered`, STYLE);
    runIdRef.current++;
    setPhase('idle');
    setDisplayedLogs([]);
    setRealProject(null);
    setRealClaims([]);
    setCurrentRunId(null);
    setApiError(null);
    setProjectLoaded(false);
    setVisibleClaimsCount(0);
    setResolvedResultsCount(0);
    setCheckingClaimIndex(-1);
    setElapsed(0);
    setInput('');
  }, []);

  // ── Derived ────────────────────────────────────────────────────────────────
  const isActive  = phase !== 'idle';
  const isRunning = phase !== 'idle' && phase !== 'complete';

  const displayProject: TokenProject | null = realProject && projectLoaded
    ? toTokenProject(realProject)
    : null;

  const frontendClaims: Claim[] = realClaims.map(toFrontendClaim);

  const claimSectionLabel = isZh
    ? (phase === 'extracting' || phase === 'analyzing'
      ? '提取宣稱'
      : phase === 'verifying'
      ? '即時驗證'
      : '驗證報告')
    : (phase === 'extracting' || phase === 'analyzing'
      ? 'Extracted Claims'
      : phase === 'verifying'
      ? 'Live Verification'
      : 'Verification Report');

  // Inject the live run at the top while active, then fall back to DB history
  const tableData = useMemo<RecentVerification[]>(() => {
    if (!isActive || !realProject) return recentScans;

    const liveRow: RecentVerification = {
      id:      currentRunId ?? 'live',
      project: {
        name:            realProject.name,
        ticker:          realProject.symbol,
        logoInitial:     realProject.name[0]?.toUpperCase() ?? '?',
        website:         realProject.website  ?? '',
        xHandle:         realProject.twitter  ?? '',
        contractAddress: realProject.contract_address,
      },
      status:         phase === 'complete' ? 'complete' : 'in_progress',
      claimsTotal:    realClaims.length,
      claimsVerified: (realClaims as DbClaim[]).filter((c) => c.status === 'verified').length,
      estTime:        isRunning ? `~${elapsed}s` : `~${elapsed}s`,
    };

    // Prepend live row, skip any stale DB entry for the same run
    return [liveRow, ...recentScans.filter((r) => r.id !== currentRunId)];
  }, [isActive, realProject, recentScans, currentRunId, phase, realClaims, elapsed, isRunning]);

  if (!entryChecked) {
    return (
      <div className="min-h-screen bg-[#050507]">
        <Navbar />
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#050507]">
      <motion.div
        initial={{ opacity: 0, y: -18, filter: 'blur(6px)' }}
        animate={pageEntered ? { opacity: 1, y: 0, filter: 'blur(0px)' } : { opacity: 0, y: -18, filter: 'blur(6px)' }}
        transition={{ duration: entryAnimation ? 0.52 : 0.36, ease: [0.16, 1, 0.3, 1] }}
      >
        <Navbar />
      </motion.div>
      <main className="pt-14">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`dashboard-${locale}`}
            initial={{
              opacity: 0,
              y: entryAnimation ? 34 : 24,
              scale: entryAnimation ? 0.985 : 0.992,
              filter: entryAnimation ? 'blur(10px)' : 'blur(8px)',
            }}
            animate={pageEntered
              ? { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }
              : {
                  opacity: 0,
                  y: entryAnimation ? 34 : 24,
                  scale: entryAnimation ? 0.985 : 0.992,
                  filter: entryAnimation ? 'blur(10px)' : 'blur(8px)',
                }}
            exit={{ opacity: 0, y: -18, filter: 'blur(6px)' }}
            transition={{ duration: entryAnimation ? 0.6 : 0.42, ease: [0.16, 1, 0.3, 1] }}
            className="max-w-[1240px] mx-auto px-8 py-14"
          >

          {/* Hero header */}
          <motion.div
            className="mb-12"
            initial={{ opacity: 0, y: entryAnimation ? 28 : 16 }}
            animate={pageEntered ? { opacity: 1, y: 0 } : { opacity: 0, y: entryAnimation ? 28 : 16 }}
            transition={{ duration: 0.52, delay: 0.06, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-600 mb-3">
                  {isZh ? '驗證控制台' : 'Verification Console'}
                </p>
                <h1 className="text-[36px] font-semibold text-white leading-tight tracking-[-0.03em]">
                  LARPSCAN<span className="text-[#dc2626]">.</span>
                </h1>
              </div>
              <div className="flex items-center gap-3 mt-1">
                <AnimatePresence>
                  {isActive && (
                    <motion.button
                      initial={{ opacity: 0, x: 8 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 8 }}
                      transition={{ duration: 0.2 }}
                      onClick={handleReset}
                      className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-600 hover:text-zinc-300 transition-colors"
                    >
                      <RotateCcw className="w-3 h-3" />
                      {isZh ? '新掃描' : 'New Scan'}
                    </motion.button>
                  )}
                </AnimatePresence>
              </div>
            </div>
            <p className="text-[14px] text-zinc-500 leading-relaxed max-w-2xl">
              {isZh
                ? '極簡介面，硬證據。系統會從真實產品面提取宣稱，再透過真實瀏覽器互動逐條驗證。'
                : 'Minimal interface, hard evidence. We extract claims from live product surfaces, then verify each claim through real browser interaction.'}
            </p>
          </motion.div>

          {/* Contract input */}
          <motion.div
            initial={{ opacity: 0, y: entryAnimation ? 26 : 18 }}
            animate={pageEntered ? { opacity: 1, y: 0 } : { opacity: 0, y: entryAnimation ? 26 : 18 }}
            transition={{ duration: 0.54, delay: 0.14, ease: [0.16, 1, 0.3, 1] }}
          >
            <ContractRow
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              isLoading={isRunning}
              forceReverify={forceReverify}
              onForceReverifyChange={setForceReverify}
              inputMode={inputMode}
              onInputModeChange={setInputMode}
            />
          </motion.div>

          {/* Error banner */}
          <AnimatePresence>
            {apiError && (
              <ErrorBanner message={apiError} onDismiss={() => setApiError(null)} />
            )}
          </AnimatePresence>

          {/* Active verification flow */}
          <AnimatePresence>
            {isActive && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
              >
                <PipelineStepper
                  phase={phase}
                  jobId={currentRunId ?? undefined}
                  elapsed={elapsed}
                />

                <ProjectIdentityBar
                  project={displayProject}
                  claimCount={
                    (phase === 'reporting' || phase === 'complete') && frontendClaims.length > 0
                      ? frontendClaims.length
                      : undefined
                  }
                />

                <div className="mb-10">
                  <SectionDivider label={claimSectionLabel} />
                  <ClaimsSection
                    phase={phase}
                    claims={frontendClaims}
                    visibleClaimsCount={visibleClaimsCount}
                    resolvedResultsCount={resolvedResultsCount}
                    checkingClaimIndex={checkingClaimIndex}
                  />
                </div>

                {displayedLogs.length > 0 && (
                  <InlineLogs logs={displayedLogs} isLive={isRunning} />
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {!isActive && <EmptyState />}

          <SectionDivider label={isZh ? '近期掃描' : 'Recent Scans'} />
          <RecentVerificationsTable verifications={tableData} onSelect={handleSelectRecentScan} />
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
