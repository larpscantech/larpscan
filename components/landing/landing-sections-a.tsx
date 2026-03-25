'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { Terminal } from 'lucide-react';
import { bodyFont, displayFont } from '@/components/landing/landing-fonts';

const EASE = [0.16, 1, 0.3, 1] as const;

const TICKER = [
  'premium motion system',
  'browser agent steps',
  'signal-first UX',
  'paper-safe verification',
  'claim extraction',
  'evidence capture',
  'verdict engine',
  'workflow replay',
];

const CLAIMS = [
  'Token creation with fee-sharing enabled and wallet gating exposed.',
  'Leaderboard logic ranked by verified holder outcomes and settlement rules.',
  'NFT mint flow with soulbound wallet binding and metadata checks.',
  'Yield vault behavior translated into concrete daily rebase test cases.',
];

const AGENT_STEPS = [
  { time: '00:01', action: 'navigate("/launch")', state: 'done' },
  { time: '00:03', action: 'extract_claims(hero copy, CTA, docs)', state: 'done' },
  { time: '00:05', action: 'fill(token_name, "TestToken")', state: 'done' },
  { time: '00:08', action: 'scroll_until(button_visible)', state: 'done' },
  { time: '00:10', action: 'click("Create Token")', state: 'active' },
  { time: '--:--', action: 'await chain response + evidence snapshot', state: 'pending' },
] as const;

export function TickerSection() {
  const items = [...TICKER, ...TICKER];

  return (
    <section className={`${bodyFont.className} overflow-hidden border-y border-white/10 bg-[#06020d] py-5`}>
      <div className="rotate-[-2deg] whitespace-nowrap">
        <div className="flex w-max animate-marquee gap-8">
          {items.map((item, index) => (
            <span
              key={`${item}-${index}`}
              className="text-[10px] font-semibold uppercase tracking-[0.32em] text-white/55"
            >
              {item}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

export function ClaimSection() {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, margin: '-80px' });

  return (
    <section
      ref={ref}
      id="how-it-works"
      className={`${bodyFont.className} mx-auto grid max-w-[1280px] gap-14 px-6 py-24 lg:grid-cols-[0.9fr_1.1fr] lg:px-8 lg:py-32`}
    >
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={inView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.6, ease: EASE }}
      >
        <p className="mb-6 text-[11px] font-semibold uppercase tracking-[0.34em] text-white/42">
          01 claim pressure
        </p>
        <h2
          className={`${displayFont.className} text-[clamp(56px,8vw,108px)] font-extrabold uppercase leading-[0.86] tracking-[-0.05em] text-white`}
        >
          Turn marketing
          <br />
          <span className="text-white/45">into test cases</span>
        </h2>
        <p className="mt-6 max-w-md text-base leading-8 text-white/58">
          The first layer reads the product the way a user does, then restructures
          every promise into something the verification loop can actually execute.
        </p>
      </motion.div>

      <motion.div
        className="grid gap-3"
        initial={{ opacity: 0, x: 20 }}
        animate={inView ? { opacity: 1, x: 0 } : {}}
        transition={{ duration: 0.7, ease: EASE, delay: 0.08 }}
      >
        {CLAIMS.map((claim, index) => (
          <motion.div
            key={claim}
            className="rounded-[28px] border border-white/10 bg-white/[0.04] px-5 py-5 backdrop-blur-2xl"
            initial={{ opacity: 0, y: 12 }}
            animate={inView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.45, delay: 0.14 + index * 0.08, ease: EASE }}
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-white/38">
              claim {String(index + 1).padStart(2, '0')}
            </p>
            <p className="mt-3 text-sm leading-7 text-white/72">{claim}</p>
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}

export function AgentSection() {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, margin: '-80px' });

  return (
    <section
      ref={ref}
      className={`${bodyFont.className} mx-auto grid max-w-[1280px] gap-14 px-6 py-24 lg:grid-cols-[1.08fr_0.92fr] lg:px-8 lg:py-32`}
    >
      <motion.div
        className="overflow-hidden rounded-[36px] border border-white/10 bg-[#090412] shadow-[0_30px_80px_rgba(0,0,0,0.35)]"
        initial={{ opacity: 0, x: -20 }}
        animate={inView ? { opacity: 1, x: 0 } : {}}
        transition={{ duration: 0.7, ease: EASE, delay: 0.06 }}
      >
        <div className="flex items-center gap-3 border-b border-white/10 px-5 py-4">
          <Terminal className="h-4 w-4 text-white/42" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.28em] text-white/42">
            orchestration log
          </span>
          <span className="ml-auto text-[10px] font-semibold uppercase tracking-[0.28em] text-[#ffd3f5]">
            live run
          </span>
        </div>

        <div className="space-y-2 px-4 py-4 sm:px-5">
          {AGENT_STEPS.map((step, index) => (
            <motion.div
              key={`${step.time}-${step.action}`}
              className="flex items-start gap-3 rounded-[20px] border border-white/8 bg-white/[0.03] px-4 py-3 font-mono text-[11px]"
              initial={{ opacity: 0, x: -10 }}
              animate={inView ? { opacity: 1, x: 0 } : {}}
              transition={{ duration: 0.4, delay: 0.18 + index * 0.07, ease: EASE }}
            >
              <span className="w-12 flex-shrink-0 text-white/30">{step.time}</span>
              <span
                className={
                  step.state === 'active'
                    ? 'text-white'
                    : step.state === 'done'
                      ? 'text-white/65'
                      : 'text-white/28'
                }
              >
                {step.state === 'active' ? '>' : step.state === 'done' ? '+' : '-'} {step.action}
              </span>
            </motion.div>
          ))}
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={inView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.6, ease: EASE }}
      >
        <p className="mb-6 text-[11px] font-semibold uppercase tracking-[0.34em] text-white/42">
          02 workflow execution
        </p>
        <h2
          className={`${displayFont.className} text-[clamp(56px,8vw,108px)] font-extrabold uppercase leading-[0.86] tracking-[-0.05em] text-white`}
        >
          Move like
          <br />
          <span className="text-white/45">a real tester</span>
        </h2>
        <p className="mt-6 max-w-md text-base leading-8 text-white/58">
          The browser loop scrolls, waits, retries, and records enough evidence to
          show where a product holds up and where the illusion breaks down.
        </p>

        <div className="mt-8 space-y-3">
          {[
            'below-fold field discovery',
            'paper-safe wallet simulation',
            'adaptive wait states',
            'evidence snapshots on failure',
          ].map((item) => (
            <div key={item} className="flex items-center gap-3">
              <span className="h-2 w-2 rounded-full bg-[#ffd3f5]" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/55">
                {item}
              </span>
            </div>
          ))}
        </div>
      </motion.div>
    </section>
  );
}
