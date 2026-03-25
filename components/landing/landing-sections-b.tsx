'use client';

import { useRef } from 'react';
import Link from 'next/link';
import { motion, useInView } from 'framer-motion';
import { ArrowRight, CheckCircle2, HelpCircle, XCircle } from 'lucide-react';
import { bodyFont, displayFont } from '@/components/landing/landing-fonts';

const EASE = [0.16, 1, 0.3, 1] as const;

const VERDICTS = [
  {
    label: 'Verified',
    description: 'Feature completed end-to-end with receipts attached.',
    icon: CheckCircle2,
    accent: 'text-emerald-300',
  },
  {
    label: 'Larp',
    description: 'The claim is visible, but the behavior never materializes.',
    icon: XCircle,
    accent: 'text-rose-300',
  },
  {
    label: 'Untestable',
    description: 'The system is real, but blocked by auth, access, or rate limits.',
    icon: HelpCircle,
    accent: 'text-amber-200',
  },
] as const;

export function Divider() {
  return (
    <div className="mx-auto max-w-[1280px] px-6 lg:px-8">
      <div className="h-px bg-gradient-to-r from-transparent via-white/12 to-transparent" />
    </div>
  );
}

export function VerdictSection() {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, margin: '-80px' });

  return (
    <section
      ref={ref}
      className={`${bodyFont.className} mx-auto grid max-w-[1280px] gap-14 px-6 py-24 lg:grid-cols-[0.92fr_1.08fr] lg:px-8 lg:py-32`}
    >
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={inView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.6, ease: EASE }}
      >
        <p className="mb-6 text-[11px] font-semibold uppercase tracking-[0.34em] text-white/42">
          03 verdict engine
        </p>
        <h2
          className={`${displayFont.className} text-[clamp(56px,8vw,108px)] font-extrabold uppercase leading-[0.86] tracking-[-0.05em] text-white`}
        >
          Remove the
          <br />
          <span className="text-white/45">guesswork</span>
        </h2>
        <p className="mt-6 max-w-md text-base leading-8 text-white/58">
          The output is intentionally simple: a verdict, the evidence behind it,
          and enough context to decide what deserves trust.
        </p>
        <Link
          href="/dashboard"
          className="mt-8 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.22em] text-white/70 transition-colors hover:text-white"
        >
          Open live console
          <ArrowRight className="h-4 w-4" />
        </Link>
      </motion.div>

      <div className="space-y-3">
        {VERDICTS.map((verdict, index) => (
          <motion.div
            key={verdict.label}
            className="rounded-[30px] border border-white/10 bg-white/[0.04] p-6 backdrop-blur-2xl"
            initial={{ opacity: 0, x: 20 }}
            animate={inView ? { opacity: 1, x: 0 } : {}}
            transition={{ duration: 0.45, delay: 0.08 + index * 0.1, ease: EASE }}
          >
            <div className="flex items-center gap-3">
              <verdict.icon className={`h-5 w-5 ${verdict.accent}`} />
              <span className={`text-[12px] font-semibold uppercase tracking-[0.28em] ${verdict.accent}`}>
                {verdict.label}
              </span>
            </div>
            <p className="mt-3 max-w-md text-sm leading-7 text-white/65">
              {verdict.description}
            </p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}

export function CtaSection() {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, margin: '-80px' });

  return (
    <section ref={ref} className={`${bodyFont.className} mx-auto max-w-[1280px] px-6 pb-24 pt-8 lg:px-8`}>
      <motion.div
        className="relative overflow-hidden rounded-[44px] border border-white/10 bg-[linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] px-6 py-12 shadow-[0_30px_100px_rgba(0,0,0,0.35)] backdrop-blur-3xl sm:px-10 sm:py-16"
        initial={{ opacity: 0, y: 24 }}
        animate={inView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.7, ease: EASE }}
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,216,244,0.18),transparent_24%),radial-gradient(circle_at_bottom_right,rgba(170,187,255,0.18),transparent_28%)]" />
        <div className="relative max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.34em] text-white/42">
            launch the first pass
          </p>
          <h2
            className={`${displayFont.className} mt-4 text-[clamp(54px,8vw,112px)] font-extrabold uppercase leading-[0.84] tracking-[-0.05em] text-white`}
          >
            Start the run
          </h2>
          <p className="mt-5 max-w-xl text-base leading-8 text-white/62">
            Paste the project, trigger the browser flow, and inspect what the
            product actually does when the interface stops speaking for it.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/dashboard"
              className="group inline-flex items-center gap-2 rounded-full border border-white/10 bg-white px-6 py-3 text-xs font-bold uppercase tracking-[0.24em] text-[#090311] transition-transform duration-200 hover:-translate-y-0.5"
            >
              Open dashboard
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <a
              href="#how-it-works"
              className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/6 px-6 py-3 text-xs font-semibold uppercase tracking-[0.24em] text-white/72 backdrop-blur-xl transition-colors duration-200 hover:text-white"
            >
              Review the system
            </a>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
