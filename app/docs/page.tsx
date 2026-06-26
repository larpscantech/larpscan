'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { ArrowRight, ShieldCheck, Bot, Scale } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { Navbar } from '@/components/navbar';

function DocBlock({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-[#1b1b21] pt-12">
      <p className="text-[10px] uppercase tracking-[0.28em] text-zinc-600 mb-4">{subtitle}</p>
      <h2 className="text-[34px] md:text-[44px] font-semibold tracking-[-0.03em] text-white mb-6">
        {title}
      </h2>
      <div className="text-zinc-400 leading-relaxed space-y-4">{children}</div>
    </section>
  );
}

function Pill({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="inline-flex items-center gap-2 border border-[#25252d] bg-[#0a0a0e] rounded-sm px-3 py-2">
      <span className="text-red-500">{icon}</span>
      <span className="text-[11px] uppercase tracking-[0.15em] text-zinc-400">{label}</span>
    </div>
  );
}

function InfoCard({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <div className="border border-[#202028] bg-[#09090d] rounded-sm p-4">
      <p className="text-[11px] uppercase tracking-[0.16em] text-red-500 mb-2">{title}</p>
      <p className="text-zinc-400 leading-relaxed">{body}</p>
    </div>
  );
}

export default function DocsPage() {
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setEntered(true), 30);
    return () => clearTimeout(t);
  }, []);

  const copy = {
        headerLabel: 'documentation',
        heroTitleMain: 'LARPSCAN docs',
        heroTitleSub: '',
        heroBody:
          'LARPSCAN verifies Solana product behavior, not marketing copy. Paste an SPL mint address — we discover the project via pump.fun and DexScreener, then run browser verification through a Phantom wallet agent.',
        pills: ['Solana mainnet', 'SOL safety limits', 'browser agent', 'deterministic verdicts'],
        tocLabel: 'on this page',
        toc: ['overview', 'verification pipeline', 'evidence output', 'verdict model', 'risk controls', 'api endpoints', 'operations guide'],
        sectionTitles: {
          overview: 'What LARPSCAN does',
          pipeline: 'Verification pipeline',
          evidence: 'Evidence output',
          verdicts: 'Verdict model',
          risk: 'Risk controls',
          api: 'Core API endpoints',
          ops: 'Operations guide',
        },
        sectionSubtitles: {
          overview: 'overview',
          pipeline: 'workflow',
          evidence: 'artifacts',
          verdicts: 'classification',
          risk: 'safety',
          api: 'api reference',
          ops: 'day-2 ops',
        },
        overviewParagraphs: [
          'LARPSCAN takes a Solana mint address, discovers project identity and web surfaces, extracts claims, then verifies each claim through real browser interaction.',
          'The system is designed to turn product language into explicit pass conditions, then collect enough runtime evidence to support a deterministic conclusion.',
          'Every run produces evidence artifacts: screenshots, logs, verdict rationale, Solana transaction signatures, and Solscan links. The target is trust through reproducibility.',
        ],
        flowCards: [
          ['01 Extract', 'Collect project metadata and scrape live product text.'],
          ['02 Analyze', 'Generate verifiable claims and pass conditions.'],
          ['03 Verify', 'Run browser-agent actions against live UI surfaces.'],
          ['04 Report', 'Assign verdicts and persist evidence artifacts.'],
        ],
        flowSketch: '// flow sketch',
        flowNotes: [
          ['Project discovery', 'Resolve token identity, website, and social context from the Solana mint (pump.fun, DexScreener, etc.).'],
          ['Claim extraction', 'Convert product language into concrete behaviors the browser agent can test.'],
          ['Browser execution', 'Phantom agent navigates, clicks, types, waits, retries, and inspects live state until enough signals are gathered.'],
          ['Result reuse', 'If a project already has a completed result, reuse it by default unless Force Reverify is enabled.'],
        ],
        evidenceItems: [
          ['Screenshots', 'Capture critical surfaces, transitions, and final states for review.'],
          ['Agent logs', 'Store the sequence of actions, waits, retries, and recoveries.'],
          ['Verdict rationale', 'Preserve the reasoning that led to the final classification.'],
          ['Transaction metadata', 'Attach Solana signatures, confirmation status, and Solscan links when on-chain interaction happens.'],
        ],
        verdict: {
          verified: ['verified', 'Claim behavior is observed with supporting evidence from live interaction.'],
          failed: ['larp / failed', 'Claimed functionality is absent, broken, or contradicted by observed behavior.'],
          untestable: ['untestable', 'Surface appears real, but execution is blocked by auth gates, insufficient funds, captchas, or external constraints outside verifier control.'],
        },
        riskItems: [
          'Solana mainnet: all mint verification and on-chain interaction runs on Solana.',
          'SOL safety limits: explicit caps on SOL spend per verification run.',
          'Phantom agent: browser injects a Phantom mock; server investigation wallet signs.',
          'Structured evidence logging for post-run auditability.',
          'Deterministic rule layer before any language-model interpretation.',
          'Reuse of completed results by default to avoid unnecessary reruns.',
        ],
        apiRows: [
          ['POST /api/project/discover', 'Resolve token project identity from Solana mint address.'],
          ['POST /api/project/extract-text', 'Scrape website text used for claim extraction.'],
          ['POST /api/claims/extract', 'Generate claims and pass conditions from scraped text.'],
          ['POST /api/verify/start', 'Create verification run record.'],
          ['POST /api/verify/run', 'Run browser verification for extracted claims.'],
          ['GET /api/verify/status', 'Fetch run status and evidence-attached claims.'],
          ['GET /api/runs/recent', 'Return recent run summaries for dashboard history.'],
        ],
        opsParagraphs: [
          'For stable operation, keep browser-agent prompts deterministic, enforce value safety limits, and monitor runs with logs plus evidence cards rather than model narrative alone.',
          'When tuning behavior, prefer small iterative changes with replayable test URLs and explicit pass conditions for each claim.',
          'Use Force Reverify only when you intentionally want a fresh run. Otherwise the dashboard can surface the latest completed result immediately.',
        ],
        openDashboard: 'open dashboard',
      };

  return (
    <div className="min-h-screen bg-[#050507] text-white">
      <motion.div
        initial={{ opacity: 0, y: -18, filter: 'blur(6px)' }}
        animate={entered ? { opacity: 1, y: 0, filter: 'blur(0px)' } : { opacity: 0, y: -18, filter: 'blur(6px)' }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      >
        <Navbar />
      </motion.div>
      <main className="pt-20">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key="docs"
            initial={{ opacity: 0, y: 22, filter: 'blur(8px)' }}
            animate={entered ? { opacity: 1, y: 0, filter: 'blur(0px)' } : { opacity: 0, y: 22, filter: 'blur(8px)' }}
            exit={{ opacity: 0, y: -18, filter: 'blur(6px)' }}
            transition={{ duration: 0.48, delay: 0.06, ease: [0.16, 1, 0.3, 1] }}
            className="max-w-[1240px] mx-auto px-8 pb-24"
          >
          <motion.header
            initial={{ opacity: 0, y: 20 }}
            animate={entered ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
            transition={{ duration: 0.52, delay: 0.14, ease: [0.16, 1, 0.3, 1] }}
            className="py-14"
          >
            <p className="text-[10px] uppercase tracking-[0.32em] text-zinc-600 mb-5">{copy.headerLabel}</p>
            <h1 className="text-[clamp(44px,8vw,110px)] leading-[0.9] font-semibold tracking-[-0.05em] max-w-[980px]">
              {copy.heroTitleMain}
              <span className="text-zinc-600">{copy.heroTitleSub}</span>
            </h1>
            <p className="text-zinc-500 mt-7 max-w-[760px] text-[16px] leading-relaxed">{copy.heroBody}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Pill icon={<ShieldCheck className="w-4 h-4" />} label={copy.pills[0]} />
              <Pill icon={<Bot className="w-4 h-4" />} label={copy.pills[1]} />
              <Pill icon={<Scale className="w-4 h-4" />} label={copy.pills[2]} />
            </div>
          </motion.header>

          <div className="grid lg:grid-cols-[250px_1fr] gap-14">
            <aside className="lg:sticky lg:top-24 h-fit">
              <p className="text-[10px] uppercase tracking-[0.28em] text-zinc-600 mb-4">{copy.tocLabel}</p>
              <nav className="flex flex-col gap-3 text-[12px] uppercase tracking-[0.16em]">
                <a href="#overview" className="text-zinc-500 hover:text-zinc-300 transition-colors">{copy.toc[0]}</a>
                <a href="#pipeline" className="text-zinc-500 hover:text-zinc-300 transition-colors">{copy.toc[1]}</a>
                <a href="#evidence" className="text-zinc-500 hover:text-zinc-300 transition-colors">{copy.toc[2]}</a>
                <a href="#verdicts" className="text-zinc-500 hover:text-zinc-300 transition-colors">{copy.toc[3]}</a>
                <a href="#risk-controls" className="text-zinc-500 hover:text-zinc-300 transition-colors">{copy.toc[4]}</a>
                <a href="#api" className="text-zinc-500 hover:text-zinc-300 transition-colors">{copy.toc[5]}</a>
                <a href="#ops" className="text-zinc-500 hover:text-zinc-300 transition-colors">{copy.toc[6]}</a>
              </nav>
            </aside>

            <div className="space-y-16">
              <DocBlock title={copy.sectionTitles.overview} subtitle={copy.sectionSubtitles.overview}>
                <div id="overview" className="-mt-20 pt-20" />
                <p>{copy.overviewParagraphs[0]}</p>
                <p>{copy.overviewParagraphs[1]}</p>
              </DocBlock>

              <DocBlock title={copy.sectionTitles.pipeline} subtitle={copy.sectionSubtitles.pipeline}>
                <div id="pipeline" className="-mt-20 pt-20" />
                <div className="grid md:grid-cols-2 gap-4">
                  {copy.flowCards.map(([step, body]) => (
                    <div key={step} className="border border-[#202028] bg-[#09090d] rounded-sm p-4">
                      <p className="text-[11px] uppercase tracking-[0.18em] text-red-500 mb-2">{step}</p>
                      <p>{body}</p>
                    </div>
                  ))}
                </div>
                <div className="border border-[#202028] bg-[#09090d] rounded-sm p-4 font-mono text-[12px] text-zinc-300">
                  <p className="text-zinc-500 mb-2">{copy.flowSketch}</p>
                  <p>discover -&gt; extract_text -&gt; claims_extract -&gt; verify_run -&gt; verify_status</p>
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  {copy.flowNotes.map(([title, body]) => (
                    <InfoCard key={title} title={title} body={body} />
                  ))}
                </div>
              </DocBlock>

              <DocBlock title={copy.sectionTitles.evidence} subtitle={copy.sectionSubtitles.evidence}>
                <div id="evidence" className="-mt-20 pt-20" />
                <p>
                  LARPSCAN does not just return a label. It returns a bundle of inspectable artifacts that answer why a verdict was assigned.
                </p>
                <div className="grid md:grid-cols-2 gap-4">
                  {copy.evidenceItems.map(([title, body]) => (
                    <InfoCard key={title} title={title} body={body} />
                  ))}
                </div>
              </DocBlock>

              <DocBlock title={copy.sectionTitles.verdicts} subtitle={copy.sectionSubtitles.verdicts}>
                <div id="verdicts" className="-mt-20 pt-20" />
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="border border-emerald-700/30 bg-emerald-950/10 rounded-sm p-4">
                    <p className="text-emerald-400 text-[11px] uppercase tracking-[0.16em] mb-2">{copy.verdict.verified[0]}</p>
                    <p>{copy.verdict.verified[1]}</p>
                  </div>
                  <div className="border border-red-700/30 bg-red-950/10 rounded-sm p-4">
                    <p className="text-red-400 text-[11px] uppercase tracking-[0.16em] mb-2">{copy.verdict.failed[0]}</p>
                    <p>{copy.verdict.failed[1]}</p>
                  </div>
                  <div className="border border-amber-700/30 bg-amber-950/10 rounded-sm p-4 md:col-span-2">
                    <p className="text-amber-400 text-[11px] uppercase tracking-[0.16em] mb-2">{copy.verdict.untestable[0]}</p>
                    <p>{copy.verdict.untestable[1]}</p>
                  </div>
                </div>
              </DocBlock>

              <DocBlock title={copy.sectionTitles.risk} subtitle={copy.sectionSubtitles.risk}>
                <div id="risk-controls" className="-mt-20 pt-20" />
                <ul className="space-y-2 list-disc pl-6">
                  {copy.riskItems.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </DocBlock>

              <DocBlock title={copy.sectionTitles.api} subtitle={copy.sectionSubtitles.api}>
                <div id="api" className="-mt-20 pt-20" />
                <div className="border border-[#202028] rounded-sm overflow-hidden">
                  <div className="grid grid-cols-[170px_1fr] text-[12px]">
                    {copy.apiRows.map(([endpoint, desc], idx) => (
                      <div key={endpoint} className={`contents ${idx % 2 === 0 ? 'bg-[#09090d]' : 'bg-[#07070a]'}`}>
                        <div className="p-3 border-b border-r border-[#202028] font-mono text-zinc-300">{endpoint}</div>
                        <div className="p-3 border-b border-[#202028] text-zinc-400">{desc}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </DocBlock>

              <DocBlock title={copy.sectionTitles.ops} subtitle={copy.sectionSubtitles.ops}>
                <div id="ops" className="-mt-20 pt-20" />
                <p>{copy.opsParagraphs[0]}</p>
                <p>{copy.opsParagraphs[1]}</p>
                <div className="pt-2">
                  <Link
                    href="/dashboard"
                    className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-red-500 hover:text-red-400 transition-colors"
                  >
                    {copy.openDashboard} <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
              </DocBlock>
            </div>
          </div>
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}

