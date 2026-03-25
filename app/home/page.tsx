'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { AnimatePresence, motion, useInView } from 'framer-motion';
import { Navbar } from '@/components/navbar';
import { useLocale } from '@/components/locale-provider';

function IntroAnimation({ onComplete }: { onComplete: () => void }) {
  const { locale } = useLocale();
  const [buildValue, setBuildValue] = useState(0);
  const [wavePhase, setWavePhase] = useState(0);
  const progress = buildValue / 100;
  const fillTop = 200 - 200 * progress;
  const waveA = Math.sin(wavePhase) * 4;
  const waveB = Math.cos(wavePhase * 1.15) * 4;
  const wavePath = `M 0 ${fillTop + waveA} C 34 ${fillTop - 6 + waveB}, 68 ${fillTop + 6 - waveA}, 100 ${fillTop + waveA} C 132 ${fillTop - 6 + waveA}, 166 ${fillTop + 6 + waveB}, 200 ${fillTop + waveB} L 200 200 L 0 200 Z`;

  useEffect(() => {
    const start = performance.now();
    const totalMs = 2200;
    let raf = 0;

    const tick = (now: number) => {
      const elapsed = now - start;
      const ratio = Math.min(1, elapsed / totalMs);
      const eased = 1 - Math.pow(1 - ratio, 3);
      setBuildValue(Math.min(100, Math.round(eased * 100)));
      setWavePhase(elapsed * 0.012);
      if (ratio < 1) raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    const t = setTimeout(onComplete, 2550);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [onComplete]);

  return (
    <motion.div
      className="fixed inset-0 z-[200] bg-[#050507] flex items-center justify-center overflow-hidden"
      exit={{ opacity: 0, transition: { duration: 0.25 } }}
    >
      <motion.div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(circle at 50% 48%, rgba(220,38,38,0.14) 0%, rgba(220,38,38,0.05) 24%, transparent 56%)',
          filter: 'blur(30px)',
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: [0.2, 0.9, 0.45] }}
        transition={{ duration: 2.1, ease: [0.16, 1, 0.3, 1] }}
      />
      <div className="relative z-10 w-full max-w-[820px] px-8 flex flex-col items-center">
        <motion.div
          className="relative w-[300px] h-[300px] sm:w-[420px] sm:h-[420px]"
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        >
          <div
            className="absolute inset-[18%] rounded-full pointer-events-none"
            style={{
              background: 'radial-gradient(circle, rgba(220,38,38,0.22) 0%, rgba(220,38,38,0.06) 40%, transparent 70%)',
              filter: 'blur(18px)',
            }}
          />
          <svg viewBox="0 0 200 200" className="w-full h-full">
            <defs>
              <clipPath id="larpscan-plus-fill">
                <path d={wavePath} />
              </clipPath>
              <clipPath id="larpscan-dot-fill">
                <path d={wavePath} />
              </clipPath>
              <linearGradient id="larpscan-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ffb3b3" />
                <stop offset="32%" stopColor="#ff6b6b" />
                <stop offset="100%" stopColor="#fff1f1" />
              </linearGradient>
            </defs>

            {/* base outline */}
            <path
              d="M100 28 V172 M28 100 H172"
              stroke="#2d2528"
              strokeWidth="28"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
            <circle cx="155" cy="155" r="16" stroke="#2d2528" strokeWidth="2" fill="none" />

            {/* filled shape */}
            <g clipPath="url(#larpscan-plus-fill)">
              <path
                d="M100 28 V172 M28 100 H172"
                stroke="url(#larpscan-fill)"
                strokeWidth="28"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </g>

            <g clipPath="url(#larpscan-dot-fill)">
              <circle cx="155" cy="155" r="16" fill="url(#larpscan-fill)" />
            </g>
          </svg>
        </motion.div>

        <div className="mt-4 flex items-center gap-10 sm:gap-14">
          <p className="text-[18px] sm:text-[24px] text-zinc-200 uppercase tracking-[0.08em]">
            {locale === 'zh-TW' ? '構建' : 'BUILD'}
          </p>
          <p className="font-mono text-[18px] sm:text-[24px] text-red-100 tabular-nums min-w-[3ch]">
            {buildValue}
          </p>
        </div>
      </div>
    </motion.div>
  );
}

function HeroSection() {
  const { locale } = useLocale();
  const copy = locale === 'zh-TW'
    ? {
        eyebrow: '極簡驗證系統',
        titleA: '少些相信。',
        titleB1: '多些',
        titleB2: '證明。',
        body: '瀏覽器代理會審核真實產品流程，只回傳證據。沒有花俏承諾，沒有猜測。',
        enter: '進入儀表板',
        method: '我們的方法',
      }
    : {
        eyebrow: 'minimal verification system',
        titleA: 'verify less.',
        titleB1: 'prove more',
        titleB2: '.',
        body: 'A browser agent audits the real product flow and returns only evidence. No glossy promises, no guessing.',
        enter: 'enter dashboard',
        method: 'our method',
      };

  return (
    <section className="relative min-h-screen flex items-center overflow-hidden pt-24">
      <div
        className="absolute -top-40 right-[-18%] w-[62vw] h-[62vw] pointer-events-none"
        style={{
          background:
            'radial-gradient(circle, rgba(220,38,38,0.18) 0%, rgba(220,38,38,0.06) 28%, transparent 66%)',
          filter: 'blur(44px)',
        }}
      />
      <div className="relative z-10 max-w-[1240px] mx-auto px-8 w-full">
        <motion.p
          className="text-[10px] uppercase tracking-[0.34em] text-zinc-500 mb-7"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
        >
          {copy.eyebrow}
        </motion.p>

        <div className="overflow-hidden">
          <motion.h1
            className="text-[clamp(58px,10vw,170px)] leading-[0.86] font-semibold text-white"
            style={{ letterSpacing: '-0.05em' }}
            initial={{ y: '105%' }}
            animate={{ y: 0 }}
            transition={{ duration: 0.82, ease: [0.16, 1, 0.3, 1], delay: 0.06 }}
          >
            {copy.titleA}
          </motion.h1>
        </div>
        <div className="overflow-hidden">
          <motion.h1
            className="text-[clamp(58px,10vw,170px)] leading-[0.86] font-semibold"
            style={{ letterSpacing: '-0.05em' }}
            initial={{ y: '105%' }}
            animate={{ y: 0 }}
            transition={{ duration: 0.82, ease: [0.16, 1, 0.3, 1], delay: 0.16 }}
          >
            <span className="text-zinc-600">{copy.titleB1}</span>
            <span className="text-red-500">{copy.titleB2}</span>
          </motion.h1>
          </div>

        <motion.div
          className="mt-12 max-w-[520px] border-l border-red-600/35 pl-6"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.58, delay: 0.4 }}
        >
          <p className="text-[16px] leading-relaxed text-zinc-400">
            {copy.body}
          </p>
        </motion.div>

        <motion.div
          className="mt-10 flex flex-wrap items-center gap-3"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.58, delay: 0.52 }}
        >
            <Link
              href="/dashboard"
              onClick={() => {
                if (typeof window !== 'undefined') {
                  window.sessionStorage.setItem('larpscan_dashboard_entry', '1');
                }
              }}
              className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-500 text-white rounded-sm px-8 py-3.5 text-[11px] font-semibold uppercase tracking-[0.18em] transition-colors duration-150"
            >
              {copy.enter} <ArrowRight className="w-3.5 h-3.5" />
            </Link>
            <a
            href="#method"
            className="inline-flex items-center text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500 hover:text-zinc-300 transition-colors"
            >
            {copy.method}
            </a>
        </motion.div>
          </div>
        </section>
  );
}

function MethodSection() {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, margin: '-120px' });
  const { locale } = useLocale();
  const items = locale === 'zh-TW'
    ? [
        { n: '01', title: '提取', body: '直接從真實頁面讀取產品宣稱。' },
        { n: '02', title: '壓力測試', body: '在受控瀏覽器中執行真實流程。' },
        { n: '03', title: '判定', body: '回傳可追溯、以證據為基礎的結論。' },
      ]
    : [
        { n: '01', title: 'extract', body: 'Read claims directly from live pages.' },
        { n: '02', title: 'stress-test', body: 'Run real flows in a controlled browser.' },
        { n: '03', title: 'verdict', body: 'Return a deterministic evidence-backed label.' },
      ];

  return (
    <section ref={ref} id="method" className="max-w-[1240px] mx-auto px-8 py-32">
      <div className="border-t border-[#1c1c22] pt-14">
        <motion.p
          className="text-[10px] uppercase tracking-[0.34em] text-zinc-600 mb-12"
          initial={{ opacity: 0, x: -40 }}
          animate={inView ? { opacity: 1, x: 0 } : {}}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        >
          {locale === 'zh-TW' ? '方法' : 'method'}
        </motion.p>
        <div className="grid md:grid-cols-3 gap-10 md:gap-8">
          {items.map((item, i) => (
            <motion.div
              key={item.n}
              initial={{ opacity: 0, x: i % 2 === 0 ? -72 : 72, y: 22 }}
              animate={inView ? { opacity: 1, x: 0, y: 0 } : {}}
              transition={{ duration: 0.7, delay: i * 0.1, ease: [0.16, 1, 0.3, 1] }}
              className="group"
            >
              <p className="text-[11px] text-red-500 tracking-[0.24em] mb-5">{item.n}</p>
              <h3 className="text-[30px] font-medium text-white tracking-[-0.03em] mb-3">
                {item.title}
              </h3>
              <p className="text-zinc-500 leading-relaxed max-w-[260px]">{item.body}</p>
              <div className="mt-7 h-px bg-gradient-to-r from-red-600/60 to-transparent opacity-20 group-hover:opacity-60 transition-opacity duration-300" />
            </motion.div>
          ))}
            </div>
          </div>
        </section>
  );
}

function StatementSection() {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, margin: '-120px' });
  const { locale } = useLocale();

  return (
    <section ref={ref} className="max-w-[1240px] mx-auto px-8 pb-28">
      <motion.div
        className="border-t border-[#1c1c22] pt-14"
        initial={{ opacity: 0, x: 70, y: 22 }}
        animate={inView ? { opacity: 1, x: 0, y: 0 } : {}}
        transition={{ duration: 0.72, ease: [0.16, 1, 0.3, 1] }}
      >
        <motion.p
          className="text-[10px] uppercase tracking-[0.34em] text-zinc-600 mb-10"
          initial={{ opacity: 0, x: -36 }}
          animate={inView ? { opacity: 1, x: 0 } : {}}
          transition={{ duration: 0.5, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
        >
          {locale === 'zh-TW' ? '聲明' : 'statement'}
        </motion.p>
        <motion.h2
          className="text-[clamp(38px,6.4vw,94px)] leading-[0.94] font-medium text-white max-w-[980px]"
          style={{ letterSpacing: '-0.045em' }}
          initial={{ opacity: 0, x: 90 }}
          animate={inView ? { opacity: 1, x: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.12, ease: [0.16, 1, 0.3, 1] }}
        >
          {locale === 'zh-TW'
            ? '如果產品無法在真實壓力下證明自己，'
            : 'if the product cannot prove itself under real pressure,'}
          <span className="text-zinc-600">
            {locale === 'zh-TW' ? ' 那它就只是 larp。' : ' it is just larp.'}
          </span>
        </motion.h2>
      </motion.div>
    </section>
  );
}

function FinalCtaSection() {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, margin: '-80px' });
  const { locale } = useLocale();

  return (
    <section ref={ref} className="max-w-[1240px] mx-auto px-8 pb-24">
      <motion.div
        className="border-t border-[#1c1c22] pt-14 flex flex-wrap items-center justify-between gap-8"
        initial={{ opacity: 0, y: 20 }}
        animate={inView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.55 }}
      >
        <motion.p
          className="text-zinc-500 text-[14px] uppercase tracking-[0.22em]"
          initial={{ opacity: 0, x: -54 }}
          animate={inView ? { opacity: 1, x: 0 } : {}}
          transition={{ duration: 0.65, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
        >
          {locale === 'zh-TW' ? '準備開始驗證' : 'ready to verify'}
        </motion.p>
        <motion.div
          initial={{ opacity: 0, x: 54 }}
          animate={inView ? { opacity: 1, x: 0 } : {}}
          transition={{ duration: 0.65, delay: 0.14, ease: [0.16, 1, 0.3, 1] }}
        >
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 border border-red-600/45 text-red-500 hover:bg-red-600 hover:text-white rounded-sm px-8 py-3.5 text-[11px] font-semibold uppercase tracking-[0.18em] transition-all duration-200"
          >
            {locale === 'zh-TW' ? '開啟儀表板' : 'open dashboard'} <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </motion.div>
      </motion.div>
    </section>
  );
}

export default function HomeLandingPage() {
  const { locale } = useLocale();
  const [introComplete, setIntroComplete] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.sessionStorage.getItem('larpscan_intro_done') === '1') {
      setIntroComplete(true);
    }
  }, []);

  const handleIntroComplete = () => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('larpscan_intro_done', '1');
    }
    setIntroComplete(true);
  };

  if (!mounted) return null;

  return (
    <div className="min-h-screen bg-[#050507] text-white overflow-x-hidden">
      <AnimatePresence>
        {!introComplete && <IntroAnimation onComplete={handleIntroComplete} key="intro" />}
      </AnimatePresence>
      <AnimatePresence mode="wait">
        {introComplete && (
          <motion.div
            key={`page-content-${locale}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, y: -10, filter: 'blur(6px)' }}
            transition={{ duration: 0.35 }}
          >
            <motion.div
              initial={{ opacity: 0, y: -22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
            >
              <Navbar />
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 34 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
            >
              <HeroSection />
            </motion.div>

            <MethodSection />
            <StatementSection />
            <FinalCtaSection />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
