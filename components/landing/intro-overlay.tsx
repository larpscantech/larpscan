'use client';

import { useEffect } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { displayFont } from '@/components/landing/landing-fonts';

type IntroOverlayProps = {
  isVisible: boolean;
  onComplete: () => void;
};

const EASE = [0.16, 1, 0.3, 1] as const;

export function IntroOverlay({ isVisible, onComplete }: IntroOverlayProps) {
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!isVisible) {
      return undefined;
    }

    const timeout = window.setTimeout(onComplete, reduceMotion ? 450 : 2500);
    return () => window.clearTimeout(timeout);
  }, [isVisible, onComplete, reduceMotion]);

  return (
    <AnimatePresence>
      {isVisible ? (
        <motion.div
          key="landing-intro"
          className="fixed inset-0 z-[200] overflow-hidden bg-[#04010a]"
          exit={{ opacity: 0, transition: { duration: 0.45, ease: EASE } }}
        >
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_34%)]" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(170,90,255,0.16),transparent_32%),radial-gradient(circle_at_80%_30%,rgba(255,132,194,0.16),transparent_26%),radial-gradient(circle_at_50%_80%,rgba(93,125,255,0.18),transparent_32%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.04),transparent_35%,rgba(255,255,255,0.02)_60%,transparent)]" />
          <div className="absolute inset-0 opacity-50 [background-image:radial-gradient(rgba(255,255,255,0.15)_0.8px,transparent_0.8px)] [background-size:24px_24px]" />

          <motion.div
            className="absolute left-1/2 top-1/2 h-[58vw] w-[58vw] max-h-[740px] max-w-[740px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/10"
            initial={{ scale: 0.82, opacity: 0 }}
            animate={{ scale: 1.08, opacity: 1 }}
            transition={{ duration: reduceMotion ? 0.3 : 1.4, ease: EASE }}
          />
          <motion.div
            className="absolute left-1/2 top-1/2 h-[42vw] w-[42vw] max-h-[520px] max-w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(255,255,255,0.2),rgba(255,255,255,0.04)_38%,transparent_64%)] blur-3xl"
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{ scale: 1.12, opacity: 1 }}
            transition={{ duration: reduceMotion ? 0.3 : 1.2, ease: EASE, delay: 0.1 }}
          />
          <motion.div
            className="absolute inset-x-0 top-[18%] h-px bg-gradient-to-r from-transparent via-white/70 to-transparent"
            initial={{ scaleX: 0, opacity: 0 }}
            animate={{ scaleX: 1, opacity: [0, 1, 0.2] }}
            transition={{ duration: reduceMotion ? 0.3 : 0.95, ease: EASE, delay: 0.15 }}
          />
          <motion.div
            className="absolute inset-y-0 left-[16%] w-px bg-gradient-to-b from-transparent via-white/30 to-transparent"
            initial={{ scaleY: 0, opacity: 0 }}
            animate={{ scaleY: 1, opacity: [0, 0.7, 0.2] }}
            transition={{ duration: reduceMotion ? 0.3 : 1.1, ease: EASE, delay: 0.2 }}
          />

          <div className="relative z-10 flex h-full items-center justify-center px-8">
            <div className="max-w-3xl text-center">
              <motion.p
                className="mb-5 text-[11px] font-semibold uppercase tracking-[0.42em] text-white/60"
                initial={{ y: 28, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.55, ease: EASE, delay: 0.08 }}
              >
                ChainVerify experience
              </motion.p>
              <div className="overflow-hidden">
                <motion.h1
                  className={`${displayFont.className} text-[clamp(64px,14vw,180px)] font-extrabold uppercase leading-[0.82] tracking-[-0.05em] text-white`}
                  initial={{ y: '100%' }}
                  animate={{ y: 0 }}
                  transition={{ duration: 0.9, ease: EASE, delay: 0.12 }}
                >
                  Signal
                </motion.h1>
              </div>
              <div className="overflow-hidden">
                <motion.h1
                  className={`${displayFont.className} bg-[linear-gradient(120deg,#ffffff_0%,#ffd3f5_35%,#adbbff_72%,#ffffff_100%)] bg-clip-text text-[clamp(64px,14vw,180px)] font-extrabold uppercase leading-[0.82] tracking-[-0.05em] text-transparent`}
                  initial={{ y: '100%' }}
                  animate={{ y: 0 }}
                  transition={{ duration: 0.9, ease: EASE, delay: 0.22 }}
                >
                  made spatial
                </motion.h1>
              </div>
              <motion.p
                className="mx-auto mt-6 max-w-xl text-sm leading-relaxed text-white/60 sm:text-base"
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, ease: EASE, delay: 0.35 }}
              >
                An elevated landing sequence for a verification engine that feels
                precise, cinematic, and premium from the first frame.
              </motion.p>
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
