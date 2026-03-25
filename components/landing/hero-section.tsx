'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { motion, useInView } from 'framer-motion';
import { bodyFont, displayFont } from '@/components/landing/landing-fonts';
import { HeroScene } from '@/components/landing/hero-scene';

const EASE = [0.16, 1, 0.3, 1] as const;

function Counter({ to, suffix = '' }: { to: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true });
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!isInView) {
      return undefined;
    }

    let frame = 0;
    const totalFrames = 42;
    const interval = window.setInterval(() => {
      frame += 1;
      const nextValue = Math.round((frame / totalFrames) * to);
      setValue(nextValue >= to ? to : nextValue);

      if (frame >= totalFrames) {
        window.clearInterval(interval);
      }
    }, 26);

    return () => window.clearInterval(interval);
  }, [isInView, to]);

  return (
    <span ref={ref}>
      {value}
      {suffix}
    </span>
  );
}

export function HeroSection() {
  return (
    <section className={`${bodyFont.className} relative min-h-screen overflow-hidden bg-[#04010a] pt-28`}>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_18%,rgba(255,255,255,0.1),transparent_18%),radial-gradient(circle_at_72%_22%,rgba(173,187,255,0.22),transparent_26%),radial-gradient(circle_at_84%_68%,rgba(255,135,215,0.18),transparent_26%),linear-gradient(180deg,rgba(3,1,8,0.2),rgba(4,1,10,0.92))]" />
      <div className="absolute inset-0 opacity-40 [background-image:linear-gradient(rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.05)_1px,transparent_1px)] [background-size:72px_72px]" />

      <div className="absolute right-[-10%] top-[8%] h-[640px] w-[640px] rounded-full bg-[#b980ff]/18 blur-[140px]" />
      <div className="absolute bottom-[-14%] left-[-8%] h-[520px] w-[520px] rounded-full bg-[#ff89d7]/14 blur-[140px]" />

      <div className="relative z-10 mx-auto grid min-h-[calc(100vh-7rem)] max-w-[1280px] items-center gap-10 px-6 pb-16 pt-10 lg:grid-cols-[0.82fr_1.18fr] lg:px-8">
        <div className="relative lg:max-w-[560px]">
          <motion.div
            className="mb-6 inline-flex items-center gap-3 rounded-full border border-white/10 bg-white/5 px-4 py-2 backdrop-blur-xl"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
          >
            <span className="h-2 w-2 rounded-full bg-[#ffd1f4]" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.34em] text-white/65">
              Verification, reimagined
            </span>
          </motion.div>

          <div className="overflow-hidden">
            <motion.h1
              className={`${displayFont.className} text-[clamp(60px,10vw,132px)] font-extrabold uppercase leading-[0.84] tracking-[-0.06em] text-white`}
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              transition={{ duration: 0.9, ease: EASE, delay: 0.05 }}
            >
              Prove
            </motion.h1>
          </div>
          <div className="overflow-hidden">
            <motion.h1
              className={`${displayFont.className} bg-[linear-gradient(120deg,#ffffff_0%,#ffd3f5_40%,#abbcff_78%,#ffffff_100%)] bg-clip-text text-[clamp(60px,10vw,132px)] font-extrabold uppercase leading-[0.84] tracking-[-0.06em] text-transparent`}
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              transition={{ duration: 0.9, ease: EASE, delay: 0.16 }}
            >
              product
            </motion.h1>
          </div>
          <div className="overflow-hidden">
            <motion.h1
              className={`${displayFont.className} text-[clamp(60px,10vw,132px)] font-extrabold uppercase leading-[0.84] tracking-[-0.06em] text-white/55`}
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              transition={{ duration: 0.9, ease: EASE, delay: 0.27 }}
            >
              reality
            </motion.h1>
          </div>

          <motion.p
            className="mt-6 max-w-xl text-base leading-8 text-white/64 sm:text-lg"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, ease: EASE, delay: 0.34 }}
          >
            ChainVerify pressure-tests the real workflow, captures evidence, and
            turns claims into something concrete, observable, and hard to fake.
          </motion.p>

          <motion.div
            className="mt-8 flex flex-wrap gap-3"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, ease: EASE, delay: 0.42 }}
          >
            <Link
              href="/dashboard"
              className="group inline-flex items-center gap-2 rounded-full border border-white/15 bg-white px-6 py-3 text-xs font-bold uppercase tracking-[0.24em] text-[#090311] transition-transform duration-200 hover:-translate-y-0.5"
            >
              Open verification console
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <a
              href="#how-it-works"
              className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/5 px-6 py-3 text-xs font-semibold uppercase tracking-[0.24em] text-white/72 backdrop-blur-xl transition-colors duration-200 hover:border-white/24 hover:text-white"
            >
              Explore the flow
            </a>
          </motion.div>

          <motion.div
            className="mt-8 grid max-w-xl gap-3 sm:grid-cols-3"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, ease: EASE, delay: 0.52 }}
          >
            {[
              { value: 92, suffix: '%', label: 'coverage' },
              { value: 23, suffix: 'k', label: 'runs' },
              { value: 3, suffix: 's', label: 'first signal' },
            ].map((item) => (
              <div
                key={item.label}
                className="rounded-[28px] border border-white/10 bg-white/6 px-5 py-5 backdrop-blur-2xl"
              >
                <p className="text-3xl font-semibold tracking-[-0.05em] text-white">
                  <Counter to={item.value} suffix={item.suffix} />
                </p>
                <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.28em] text-white/45">
                  {item.label}
                </p>
              </div>
            ))}
          </motion.div>
        </div>

        <motion.div
          className="relative min-h-[460px] lg:min-h-[620px]"
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, ease: EASE, delay: 0.2 }}
        >
          <div className="absolute inset-0 rounded-[40px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.12),rgba(255,255,255,0.03))] shadow-[0_30px_120px_rgba(0,0,0,0.5)] backdrop-blur-3xl" />
          <div className="absolute inset-[1px] rounded-[40px] bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.12),transparent_30%),linear-gradient(180deg,rgba(10,4,18,0.96),rgba(5,1,9,0.9))]" />

          <div className="absolute inset-0 overflow-hidden rounded-[40px]">
            <HeroScene />
          </div>

          <div className="absolute left-6 top-6 rounded-full border border-white/10 bg-black/25 px-4 py-2 backdrop-blur-xl">
            <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-white/58">
              Spatial intro system
            </p>
          </div>

          <div className="absolute bottom-6 left-6 right-6 grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="rounded-[28px] border border-white/10 bg-black/24 p-5 backdrop-blur-2xl">
              <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-white/48">
                Visual language
              </p>
              <p className="mt-3 max-w-sm text-sm leading-6 text-white/70">
                Glass, bloom, depth, and pointer-reactive motion give the landing
                page a more premium motion-designer feel without needing a 3D asset
                pipeline yet.
              </p>
            </div>
            <div className="rounded-[28px] border border-white/10 bg-white/8 p-5 backdrop-blur-2xl">
              <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-white/48">
                Current pass
              </p>
              <p className="mt-3 text-lg font-semibold tracking-[-0.03em] text-white">
                Intro overlay + WebGL hero
              </p>
              <p className="mt-2 text-sm leading-6 text-white/55">
                First step toward a full premium homepage system.
              </p>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
