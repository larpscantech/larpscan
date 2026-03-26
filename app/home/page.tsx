'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { AnimatePresence, motion, useInView } from 'framer-motion';
import { Navbar } from '@/components/navbar';
import { useLocale } from '@/components/locale-provider';

// Fill phase: 0 – 1800 ms  |  Exit: 2100 ms
const FILL_END_MS = 1800;
const EXIT_MS     = 2100;

function IntroAnimation({ onComplete }: { onComplete: () => void }) {
  const { locale } = useLocale();

  const [tick, setTick] = useState({ fillProgress: 0, waveT: 0, buildValue: 0 });

  useEffect(() => {
    let raf = 0;
    const origin = performance.now();

    const step = (now: number) => {
      const elapsed   = now - origin;
      const fillRatio = Math.min(1, elapsed / FILL_END_MS);
      const eased     = 1 - Math.pow(1 - fillRatio, 2.5);

      setTick({ fillProgress: eased, waveT: elapsed * 0.006, buildValue: Math.round(eased * 100) });

      if (elapsed < FILL_END_MS) raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    const done = setTimeout(onComplete, EXIT_MS);
    return () => { cancelAnimationFrame(raf); clearTimeout(done); };
  }, [onComplete]);

  const { fillProgress, waveT, buildValue } = tick;

  const topY = 200 * (1 - fillProgress);
  const amp  = 10 * Math.max(0, 1 - fillProgress * 1.1);
  const sin  = (p: number) => amp * Math.sin(waveT + p);

  const wavePath = fillProgress > 0.001
    ? [
        `M 0 ${topY + sin(0)}`,
        `C 40 ${topY - amp + sin(1)}, 80 ${topY + amp + sin(2)}, 100 ${topY + sin(3)}`,
        `C 130 ${topY - amp + sin(4)}, 165 ${topY + amp + sin(1.5)}, 200 ${topY + sin(2.5)}`,
        `L 200 200 L 0 200 Z`,
      ].join(' ')
    : null;

  return (
    <motion.div
      className="fixed inset-0 z-[200] bg-[#050507] flex items-center justify-center overflow-hidden"
      exit={{ opacity: 0, transition: { duration: 0.3 } }}
    >
      <motion.div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(circle at 50% 48%, rgba(220,38,38,0.12) 0%, rgba(220,38,38,0.04) 35%, transparent 60%)',
          filter: 'blur(40px)',
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.5 }}
      />

      <div className="relative z-10 flex flex-col items-center px-8">
        <motion.div
          className="relative w-[280px] h-[280px] sm:w-[380px] sm:h-[380px]"
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        >
          <svg viewBox="0 0 200 200" className="w-full h-full">
            <defs>
              <mask id="ls-mask" maskUnits="userSpaceOnUse">
                <rect x="0" y="0" width="200" height="200" fill="black" />
                <path d="M100 28 V172 M28 100 H172"
                  stroke="white" strokeWidth="28" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                <circle cx="155" cy="155" r="16" fill="white" />
              </mask>
              <linearGradient id="ls-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor="#ff8a94" />
                <stop offset="50%"  stopColor="#f03848" />
                <stop offset="100%" stopColor="#c42040" />
              </linearGradient>
            </defs>

            {/* Cross — always fully visible, dark base */}
            <path d="M100 28 V172 M28 100 H172"
              stroke="#1a1218" strokeWidth="28" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <circle cx="155" cy="155" r="16" fill="#1a1218" />

            {/* Wavy red fill rises through the cross */}
            {wavePath && (
              <g mask="url(#ls-mask)">
                <path d={wavePath} fill="url(#ls-fill)" />
              </g>
            )}
          </svg>
        </motion.div>

        <motion.div
          className="mt-8 flex items-center gap-10"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.15 }}
        >
          <span className="text-[15px] sm:text-[18px] text-zinc-500 uppercase tracking-[0.14em]">
            {locale === 'zh-TW' ? '構建' : 'BUILD'}
          </span>
          <span className="font-mono text-[15px] sm:text-[18px] text-red-400 tabular-nums min-w-[3ch]">
            {buildValue}
          </span>
        </motion.div>
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
  const [introChecked, setIntroChecked] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem('larpscan_intro_done') === '1') {
      setIntroComplete(true);
    }
    setIntroChecked(true);
  }, []);

  const handleIntroComplete = () => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('larpscan_intro_done', '1');
    }
    setIntroComplete(true);
  };

  if (!mounted || !introChecked) return null;

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
