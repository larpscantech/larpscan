'use client';

import Link from 'next/link';
import { ArrowRight, ShieldCheck, Bot, Scale } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { Navbar } from '@/components/navbar';
import { useLocale } from '@/components/locale-provider';

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

export default function DocsPage() {
  const { locale } = useLocale();
  const isZh = locale === 'zh-TW';

  const copy = isZh
    ? {
        headerLabel: '文件',
        heroTitleMain: 'LARPSCAN 文件',
        heroTitleSub: '：以證據優先的驗證系統。',
        heroBody:
          'LARPSCAN 驗證的是產品真實行為，而不是行銷敘述。本頁涵蓋架構、流程、判定邏輯與安全運行模式。',
        pills: ['安全保護欄', '瀏覽器代理', '可重現判定'],
        tocLabel: '本頁內容',
        toc: ['總覽', '驗證流程', '判定模型', '風險控制', 'API 端點', '運維指南'],
        sectionTitles: {
          overview: 'LARPSCAN 的核心工作',
          pipeline: '驗證流程',
          verdicts: '判定模型',
          risk: '風險控制',
          api: '核心 API 端點',
          ops: '運維指南',
        },
        sectionSubtitles: {
          overview: '總覽',
          pipeline: '流程',
          verdicts: '分類',
          risk: '安全',
          api: 'api 參考',
          ops: '日常運維',
        },
        overviewParagraphs: [
          'LARPSCAN 接收合約地址、識別專案與網站面，再提取可驗證宣稱，最後以真實瀏覽器互動逐條驗證。',
          '每次執行都會產生證據物件：截圖、日誌、判定理由、交易資訊與重播上下文，目標是可重現的信任。',
        ],
        flowCards: [
          ['01 提取', '收集專案 metadata，並抓取真實產品文字內容。'],
          ['02 分析', '生成可驗證宣稱與通過條件。'],
          ['03 驗證', '在真實 UI 面執行瀏覽器代理操作。'],
          ['04 報告', '寫入判定並保存證據。'],
        ],
        flowSketch: '// 流程草圖',
        verdict: {
          verified: ['已驗證', '觀測到與宣稱一致的行為，且具備支撐證據。'],
          failed: ['LARP / 失敗', '宣稱功能不存在、故障，或與實際行為相矛盾。'],
          untestable: [
            '不可測',
            '功能面看似存在，但被登入、資金不足、驗證碼或外部限制阻擋。',
          ],
        },
        riskItems: [
          '安全保護欄：預設避免高風險執行路徑。',
          '交易金額有明確上限與保護欄。',
          '結構化證據日誌，支援事後審計。',
          '在語言模型判定前先套用規則層。',
          '模組化隔離，便於測試與安全迭代。',
        ],
        apiRows: [
          ['POST /api/project/discover', '根據合約地址解析專案身份資訊。'],
          ['POST /api/project/extract-text', '抓取網站文字作為宣稱提取輸入。'],
          ['POST /api/claims/extract', '從內容生成宣稱與通過條件。'],
          ['POST /api/verify/start', '建立驗證執行紀錄。'],
          ['POST /api/verify/run', '對提取宣稱執行瀏覽器驗證。'],
          ['GET /api/verify/status', '讀取執行狀態與附證據宣稱。'],
          ['GET /api/runs/recent', '取得儀表板近期執行摘要。'],
        ],
        opsParagraphs: [
          '為了穩定運行，請保持代理提示詞可重現、強制交易安全上限，並以日誌與證據卡片監控，而非只看模型敘述。',
          '調整行為時建議小步迭代，並搭配可回放的測試 URL 與明確 pass condition。',
        ],
        openDashboard: '開啟儀表板',
      }
    : {
        headerLabel: 'documentation',
        heroTitleMain: 'LARPSCAN docs',
        heroTitleSub: ' for evidence-first verification.',
        heroBody:
          'LARPSCAN verifies what products actually do, not what marketing claims. This page covers architecture, workflow, verdict logic, and safe operating mode.',
        pills: ['safety guardrails', 'browser agent', 'deterministic verdicts'],
        tocLabel: 'on this page',
        toc: ['overview', 'verification pipeline', 'verdict model', 'risk controls', 'api endpoints', 'operations guide'],
        sectionTitles: {
          overview: 'What LARPSCAN does',
          pipeline: 'Verification pipeline',
          verdicts: 'Verdict model',
          risk: 'Risk controls',
          api: 'Core API endpoints',
          ops: 'Operations guide',
        },
        sectionSubtitles: {
          overview: 'overview',
          pipeline: 'workflow',
          verdicts: 'classification',
          risk: 'safety',
          api: 'api reference',
          ops: 'day-2 ops',
        },
        overviewParagraphs: [
          'LARPSCAN takes a contract address, discovers project identity and web surfaces, extracts claims, then verifies each claim through real browser interaction.',
          'Every run produces evidence artifacts: screenshots, logs, verdict rationale, transaction metadata, and replay context. The target is trust through reproducibility.',
        ],
        flowCards: [
          ['01 Extract', 'Collect project metadata and scrape live product text.'],
          ['02 Analyze', 'Generate verifiable claims and pass conditions.'],
          ['03 Verify', 'Run browser-agent actions against live UI surfaces.'],
          ['04 Report', 'Assign verdicts and persist evidence artifacts.'],
        ],
        flowSketch: '// flow sketch',
        verdict: {
          verified: ['verified', 'Claim behavior is observed with supporting evidence from live interaction.'],
          failed: ['larp / failed', 'Claimed functionality is absent, broken, or contradicted by observed behavior.'],
          untestable: ['untestable', 'Surface appears real, but execution is blocked by auth gates, insufficient funds, captchas, or external constraints outside verifier control.'],
        },
        riskItems: [
          'Paper mode first: no live trading execution path.',
          'Transaction value guardrails with explicit safety limits.',
          'Structured evidence logging for post-run auditability.',
          'Deterministic rule layer before any language-model interpretation.',
          'Module-level isolation for testability and controlled changes.',
        ],
        apiRows: [
          ['POST /api/project/discover', 'Resolve token project identity from contract address.'],
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
        ],
        openDashboard: 'open dashboard',
      };

  return (
    <div className="min-h-screen bg-[#050507] text-white">
      <Navbar />
      <main className="pt-20">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`docs-${locale}`}
            initial={{ opacity: 0, y: 18, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -18, filter: 'blur(6px)' }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="max-w-[1240px] mx-auto px-8 pb-24"
          >
          <motion.header
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45 }}
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
                <a href="#verdicts" className="text-zinc-500 hover:text-zinc-300 transition-colors">{copy.toc[2]}</a>
                <a href="#risk-controls" className="text-zinc-500 hover:text-zinc-300 transition-colors">{copy.toc[3]}</a>
                <a href="#api" className="text-zinc-500 hover:text-zinc-300 transition-colors">{copy.toc[4]}</a>
                <a href="#ops" className="text-zinc-500 hover:text-zinc-300 transition-colors">{copy.toc[5]}</a>
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
