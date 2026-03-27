'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ArrowRight, RotateCcw, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Navbar } from '@/components/navbar';
import { PipelineStepper } from '@/components/pipeline-stepper';
import { ProjectIdentityBar } from '@/components/project-identity-bar';
import { AuditClaimCard, AuditClaimCardSkeleton, AnimatedClaimCard } from '@/components/audit-claim-card';
import { InlineLogs } from '@/components/inline-logs';
import { RecentVerificationsTable } from '@/components/recent-verifications-table';
import { useLocale } from '@/components/locale-provider';
import { cn } from '@/lib/utils';
import type { Phase, ScanType, TokenProject, Claim, Verdict, RecentVerification } from '@/lib/types';
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
    evidence:               (evidenceData?.['reasoning']              as string  | undefined) ?? undefined,
    screenshotDataUrl:      (evidenceData?.['screenshotDataUrl']      as string  | undefined) ?? undefined,
    videoUrl:               (evidenceData?.['videoUrl']               as string  | undefined) ?? undefined,
    transactionHash:        (evidenceData?.['transactionHash']        as string  | undefined) ?? undefined,
    transactionExplorerUrl: (evidenceData?.['transactionExplorerUrl'] as string  | undefined) ?? undefined,
    transactionReceiptStatus:
      (evidenceData?.['transactionReceiptStatus'] as Claim['transactionReceiptStatus']) ?? undefined,
    transactionAttempted:   (evidenceData?.['transactionAttempted']   as boolean | undefined) ?? undefined,
    walletAddress:          (evidenceData?.['walletAddress']          as string  | undefined) ?? undefined,
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

// ─── Scan selector ────────────────────────────────────────────────────────────

function ScanSelector({ value, onChange }: { value: ScanType; onChange: (v: ScanType) => void }) {
  const { locale } = useLocale();
  const isZh = locale === 'zh-TW';
  return (
    <div className="flex gap-0.5 p-1 rounded-sm bg-[#0a0a0d] border border-[#1c1c22]">
      {(['full', 'quick'] as const).map((type) => (
        <button
          key={type}
          onClick={() => onChange(type)}
          className={cn(
            'px-3.5 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] rounded-sm transition-all duration-150 whitespace-nowrap',
            value === type
              ? 'bg-[#1a0707] text-[#f87171] border border-[#b91c1c]/30'
              : 'text-zinc-600 hover:text-zinc-400',
          )}
        >
          {type === 'full'
            ? isZh ? '完整掃描' : 'Full Scan'
            : isZh ? '快速掃描' : 'Quick Scan'}
        </button>
      ))}
    </div>
  );
}

// ─── Contract input row ───────────────────────────────────────────────────────

function ContractRow({
  value, onChange, onSubmit, isLoading,
  scanType, onScanTypeChange, forceReverify, onForceReverifyChange,
}: {
  value: string; onChange: (v: string) => void; onSubmit: () => void; isLoading: boolean;
  scanType: ScanType; onScanTypeChange: (v: ScanType) => void;
  forceReverify: boolean; onForceReverifyChange: (v: boolean) => void;
}) {
  const { locale } = useLocale();
  const isZh = locale === 'zh-TW';
  return (
      <div className="mb-12">
      <div className="flex items-center gap-3 mb-3">
        <ScanSelector value={scanType} onChange={onScanTypeChange} />
        <div className="flex-1 relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 font-mono text-xs text-zinc-700 pointer-events-none select-none">$</span>
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !isLoading && onSubmit()}
            disabled={isLoading}
            placeholder={isZh ? '輸入代幣合約地址...' : 'Enter token contract address...'}
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

      <label className="flex items-center gap-2.5 cursor-pointer w-fit group ml-1">
        <div
          onClick={() => onForceReverifyChange(!forceReverify)}
          className={cn(
            'w-3.5 h-3.5 rounded border flex items-center justify-center transition-all',
            forceReverify ? 'bg-[#1c0808] border-[#b91c1c]/50' : 'border-cv-border group-hover:border-zinc-600',
          )}
        >
          {forceReverify && (
            <svg className="w-2 h-2 text-[#dc2626]" viewBox="0 0 8 8" fill="none">
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
          if (i < resolvedResultsCount) {
            return <AuditClaimCard key={claim.id} claim={claim} index={i} defaultExpanded={true} />;
          }
          if (i === checkingClaimIndex) {
            return (
              <AuditClaimCard
                key={claim.id}
                claim={{ ...claim, verdict: undefined, evidence: undefined }}
                index={i}
                isChecking={true}
              />
            );
          }
          if (i < visibleClaimsCount) {
            return (
              <AuditClaimCard
                key={claim.id}
                claim={{ ...claim, verdict: undefined, evidence: undefined }}
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
  const [scanType, setScanType]         = useState<ScanType>('full');
  const [forceReverify, setForceReverify] = useState(false);

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

  const runIdRef = useRef(0);

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
      __chainverifySetAddress?: (addr: string) => void;
      __larpscanSetAddress?: (addr: string) => void;
    };
    const setAddress = (addr: string) => {
      setInput(addr);
    };
    w.__chainverifySetAddress = setAddress;
    w.__larpscanSetAddress = setAddress;
    return () => {
      delete w.__chainverifySetAddress;
      delete w.__larpscanSetAddress;
    };
  }, []);

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

  // ── Core verification pipeline ────────────────────────────────────────────────
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
    console.log('  scan type:', scanType);
    console.log('  timestamp:', new Date().toISOString());

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 1 — EXTRACTING: validate contract + discover project metadata
    // ─────────────────────────────────────────────────────────────────────────
    setPhase('extracting');
    addLog('Initializing verification job...');
    addLog(`Resolving contract: ${address.slice(0, 10)}...`);

    let project: DbProject;
    try {
      console.log(`${TAG} Phase → extracting`, STYLE);
      const res = await apiPost<{ project: DbProject }>(
        '/api/project/discover',
        '/api/project/discover',
        { contractAddress: address },
      );
      project = res.project;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Contract discovery failed';
      console.error(`${TAG} Discovery failed:`, STYLE, msg);
      addLog(`✗ Error: ${msg}`);
      setApiError(msg);
      setPhase('idle');
      console.groupEnd();
      return;
    }

    if (!alive()) { console.groupEnd(); return; }

    console.log(`${TAG} Project discovered:`, STYLE, project);
    addLog(`Token: ${project.name} (${project.symbol})`);
    if (project.website) addLog(`Website: ${project.website}`);
    if (project.twitter) addLog(`Social: ${project.twitter}`);
    if (!project.website && !project.twitter) addLog('No web presence found for this contract');

    setRealProject(project);
    setProjectLoaded(true);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2 — ANALYZING: start run + scrape website + extract claims via LLM
    // ─────────────────────────────────────────────────────────────────────────
    setPhase('analyzing');
    addLog('Starting verification run...');

    console.log(`${TAG} Phase → analyzing`, STYLE);

    // Create the run record in Supabase
    let runRecord: { runId: string; run: DbVerificationRun; reused?: boolean };
    try {
      runRecord = await apiPost<{ runId: string; run: DbVerificationRun; reused?: boolean }>(
        '/api/verify/start',
        '/api/verify/start',
        { projectId: project.id, forceReverify },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to create verification run';
      console.error(`${TAG} verify/start failed:`, STYLE, msg);
      addLog(`✗ Error: ${msg}`);
      setApiError(msg);
      setPhase('idle');
      console.groupEnd();
      return;
    }

    if (!alive()) { console.groupEnd(); return; }

    const runId = runRecord.runId;
    setCurrentRunId(runId);
    console.log(`${TAG} Run created — ID:`, STYLE, runId);
    addLog(`Run ID: ${runId.slice(0, 8)}...`);

    // Fast path: use cached completed run if available
    if (runRecord.reused) {
      addLog('Existing completed run found — loading cached result');
      let cachedLoaded = false;

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
        cachedLoaded = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to load cached run';
        console.warn(`${TAG} Failed to load cached run, continuing fresh:`, STYLE, msg);
        addLog('Cached run unavailable — continuing with fresh verification');
      }

      if (cachedLoaded || !alive()) {
        console.groupEnd();
        return;
      }
    }

    // Scrape the project website
    let websiteText = '';
    if (project.website) {
      addLog(`Extracting website content from ${project.website}...`);
      console.log(`${TAG} Scraping website:`, STYLE, project.website);

      try {
        const textRes = await apiPost<{ text: string; charCount: number }>(
          '/api/project/extract-text',
          '/api/project/extract-text',
          { website: project.website },
        );
        websiteText = textRes.text;
        addLog(`Website scraped — ${textRes.charCount} chars extracted`);
        console.log(`${TAG} Website text preview (first 300 chars):`, STYLE);
        console.log('  ', websiteText.slice(0, 300));
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Scrape failed';
        console.warn(`${TAG} Website extraction failed (non-fatal):`, STYLE, msg);
        addLog(`Website scraping failed — ${msg}`);
        addLog('Continuing without website content');
      }
    } else {
      console.warn(`${TAG} No website on record for this project — skipping scrape`, STYLE);
      addLog('No website found — skipping content extraction');
    }

    if (!alive()) { console.groupEnd(); return; }

    // Extract claims via LLM
    if (!websiteText) {
      addLog('No website content available — 0 claims extracted');
      console.warn(`${TAG} No website text → skipping LLM extraction`, STYLE);
      setPhase('reporting');
      await sleep(1200);
      if (!alive()) { console.groupEnd(); return; }
      setPhase('complete');
      addLog('Run complete — no claims to verify');
      console.log(`${TAG} Run complete (no claims)`, STYLE);
      console.groupEnd();
      return;
    }

    if (project.twitter) addLog(`Scraping X profile ${project.twitter}...`);
    addLog('Running AI claim extraction model...');
    console.log(`${TAG} Calling /api/claims/extract with ${websiteText.length} chars`, STYLE);

    let extractedClaims: DbClaim[] = [];
    try {
      const claimsRes = await apiPost<{
        claims:   DbClaim[];
        count:    number;
        xScraped: boolean;
        xChars:   number;
        twitter:  string | null;
      }>(
        '/api/claims/extract',
        '/api/claims/extract',
        { projectId: project.id, runId, websiteText },
      );
      extractedClaims = claimsRes.claims;
      if (claimsRes.xScraped) {
        addLog(`X profile scraped — ${claimsRes.xChars} chars`);
      } else if (claimsRes.twitter) {
        addLog('X profile unavailable — using website only');
      }
      console.log(`${TAG} LLM returned ${claimsRes.count} claim(s):`, STYLE);
      console.table(
        claimsRes.claims.map((c) => ({ claim: c.claim, pass_condition: c.pass_condition })),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Claim extraction failed';
      console.error(`${TAG} claims/extract failed:`, STYLE, msg);
      addLog(`✗ Claim extraction failed: ${msg}`);
      setApiError(msg);
      setPhase('idle');
      console.groupEnd();
      return;
    }

    if (!alive()) { console.groupEnd(); return; }

    setRealClaims(extractedClaims);

    if (extractedClaims.length === 0) {
      addLog('No verifiable product claims found on this website');
      console.warn(`${TAG} LLM found 0 verifiable claims`, STYLE);
    } else {
      // Stagger-reveal claims one by one as they appear from the LLM response
      for (let i = 0; i < extractedClaims.length; i++) {
        if (!alive()) { console.groupEnd(); return; }
        await sleep(480);
        setVisibleClaimsCount(i + 1);
        const label = extractedClaims[i].claim.slice(0, 60);
        addLog(`Claim ${String(i + 1).padStart(2, '0')} — ${label}`);
        console.log(`${TAG} Claim ${i + 1} revealed:`, STYLE, extractedClaims[i]);
      }

      addLog(`${extractedClaims.length} claim${extractedClaims.length === 1 ? '' : 's'} extracted — awaiting verification automation`);
    }

    if (!alive()) { console.groupEnd(); return; }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 3 — VERIFYING: Playwright browser runs each claim against live product
    // ─────────────────────────────────────────────────────────────────────────
    console.log(`${TAG} Phase → verifying`, STYLE);
    setPhase('verifying');
    setCheckingClaimIndex(0);

    if (extractedClaims.length > 0) {
      addLog('Launching browser verification engine...');
      addLog(`Target: ${project.website}`);

      // Rotate the "checking" indicator across claims while the long request runs
      let rotateIdx = 0;
      const claimCount = extractedClaims.length;
      const rotatePeriodMs = Math.max(3_000, Math.floor(20_000 / claimCount));

      const rotateTimer = setInterval(() => {
        if (!alive()) { clearInterval(rotateTimer); return; }
        rotateIdx = (rotateIdx + 1) % claimCount;
        setCheckingClaimIndex(rotateIdx);
      }, rotatePeriodMs);

      // Dispatch claims — /api/verify/run now returns immediately after
      // fanning out each claim to its own serverless function.
      try {
        console.log(`${TAG} Dispatching claims via /api/verify/run`, STYLE);
        await apiPost<{ runId: string; results: unknown[] }>(
          '/api/verify/run',
          '/api/verify/run',
          { runId },
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Verification engine failed';
        console.error(`${TAG} verify/run dispatch failed:`, STYLE, msg);
        addLog(`✗ Browser verification failed: ${msg}`);
      }

      if (!alive()) { clearInterval(rotateTimer); console.groupEnd(); return; }

      // Poll /api/verify/status until ALL claims are done, then reveal
      // everything at once so the UI doesn't glitch with partial results.
      const maxPollMs = 10 * 60 * 1000;
      const pollStart = Date.now();
      let finalStatus: { claims: DbClaimWithEvidence[]; logs: { message: string }[] } | null = null;

      while (alive() && Date.now() - pollStart < maxPollMs) {
        await sleep(5_000);
        if (!alive()) break;

        try {
          const statusRes = await apiGet<{
            run:    DbVerificationRun;
            claims: DbClaimWithEvidence[];
            logs:   { message: string }[];
          }>('/api/verify/status', `/api/verify/status?runId=${runId}`);

          const allDone =
            statusRes.run.status === 'complete' ||
            statusRes.claims.every((c) => c.status !== 'pending' && c.status !== 'checking');

          if (allDone) {
            finalStatus = statusRes;
            console.log(`${TAG} All claims resolved`, STYLE);
            break;
          }
        } catch (e) {
          console.warn(`${TAG} Status poll failed (retrying):`, STYLE, e);
        }
      }

      clearInterval(rotateTimer);
      setCheckingClaimIndex(-1);

      // Reveal all results at once
      if (finalStatus) {
        setRealClaims(finalStatus.claims);
        for (let i = 0; i < finalStatus.claims.length; i++) {
          if (!alive()) break;
          await sleep(450);
          setResolvedResultsCount(i + 1);
          const c = finalStatus.claims[i];
          addLog(`Claim ${String(i + 1).padStart(2, '0')} → ${c.status.toUpperCase()}`);
          console.log(`${TAG} Revealed claim ${i + 1}: ${c.status}`, STYLE);
        }
      }
    }

    if (!alive()) { console.groupEnd(); return; }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 4 — REPORTING: assemble final report
    // ─────────────────────────────────────────────────────────────────────────
    console.log(`${TAG} Phase → reporting`, STYLE);
    setPhase('reporting');
    await sleep(400);
    addLog('Assembling verification report...');
    await sleep(800);

    if (!alive()) { console.groupEnd(); return; }

    // ── COMPLETE ──────────────────────────────────────────────────────────────
    setPhase('complete');
    addLog('Verification run complete ✓');

    // Refresh the recent scans table now that this run is persisted
    void fetchRecentScans();

    console.log(`${TAG} ══ Run complete ══`, STYLE, {
      project: project.name,
      runId,
      claims: extractedClaims.length,
      elapsed: `${elapsed}s`,
    });
    console.groupEnd();
  }, [input, scanType, forceReverify, addLog, elapsed, fetchRecentScans]);

  // ── Reset ──────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(() => {
    if (!input.trim() || (phase !== 'idle' && phase !== 'complete')) return;
    startVerification();
  }, [input, phase, startVerification]);

  // ── Load a previous scan from the recent-scans table ───────────────────────
  const handleSelectRecentScan = useCallback((v: import('@/lib/types').RecentVerification) => {
    if (phase !== 'idle' && phase !== 'complete') return;
    setInput(v.project.contractAddress);
    // Pass the address directly so startVerification doesn't race with setState
    startVerification(v.project.contractAddress);
  }, [phase, startVerification]);

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
              scanType={scanType}
              onScanTypeChange={setScanType}
              forceReverify={forceReverify}
              onForceReverifyChange={setForceReverify}
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
