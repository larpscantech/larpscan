'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { Copy } from 'lucide-react';
import { cn, truncateAddressPump } from '@/lib/utils';
import { useLocale } from '@/components/locale-provider';
import { ConnectWalletButton } from '@/components/connect-wallet-button';

export type NavbarProps = {
  /**
   * When set (e.g. on the dashboard), shows a compact CA / URL chip next to the logo:
   * raw `0x…` address, `url:host` from DB, or an `https://` website URL.
   */
  contractContext?: string | null;
};

type ParsedContext = { kind: 'ca' | 'url'; full: string; display: string };

function parseContractContext(raw: string | null | undefined): ParsedContext | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('url:')) {
    const rest = s.slice(4);
    const display =
      rest.length > 28 ? `${rest.slice(0, 10)}…${rest.slice(-6)}` : rest;
    return { kind: 'url', full: s, display };
  }
  if (/^0x[0-9a-fA-F]{40,}$/i.test(s)) {
    return { kind: 'ca', full: s, display: truncateAddressPump(s) };
  }
  if (/^https?:\/\//i.test(s)) {
    try {
      const host = new URL(s).hostname;
      return { kind: 'url', full: s, display: host.length > 32 ? `${host.slice(0, 14)}…` : host };
    } catch {
      return null;
    }
  }
  return null;
}

function Logo() {
  return (
    <div className="flex items-center gap-3">
      <svg
        className="w-7 h-7 flex-shrink-0 text-red-500"
        viewBox="0 0 64 64"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M18 12H8v10" />
        <path d="M46 12h10v10" />
        <path d="M18 52H8V42" />
        <path d="M46 52h10V42" />
        <path d="M20 28l8 5-8 5" />
        <path d="M44 28l-8 5 8 5" />
        <path d="M25 43c2 4 5 6 7 6s5-2 7-6" />
      </svg>
      <span className="text-[13px] font-bold tracking-tight">
        <span className="text-white">LARP</span>
        <span className="text-red-500">SCAN</span>
      </span>
    </div>
  );
}

function XIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function Navbar({ contractContext }: NavbarProps = {}) {
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();
  const { locale, setLocale } = useLocale();

  const parsedContext = useMemo(
    () => parseContractContext(contractContext ?? null),
    [contractContext],
  );

  const copy = locale === 'zh-TW'
    ? {
        home:      '首頁',
        docs:      '文件',
        open:      '進入儀表板',
        labelCa:   '合約',
        labelUrl:  '網址',
        copyLabel: '複製到剪貼簿',
      }
    : {
        home:      'Home',
        docs:      'Docs',
        open:      'Enter Dashboard',
        labelCa:   'CA',
        labelUrl:  'URL',
        copyLabel: 'Copy to clipboard',
      };

  const NAV_LINKS = [
    { label: copy.home, href: '/home' },
    { label: copy.docs, href: '/docs' },
  ];

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <nav
      className={cn(
        'fixed top-0 left-0 right-0 z-50 transition-all duration-300',
        scrolled
          ? 'bg-[#050507]/80 backdrop-blur-xl border-b border-[#1a1a20]'
          : 'bg-[#050507]/60 backdrop-blur-lg border-b border-transparent',
      )}
    >
      <div className="max-w-[1240px] mx-auto px-8">
        <div className="flex items-center justify-between h-[64px] gap-3">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 shrink">
            <Link href="/home" className="hover:opacity-80 transition-opacity duration-150 flex-shrink-0">
              <Logo />
            </Link>
            {parsedContext && (
              <div
                className="hidden min-[400px]:flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-sm border border-[#1f1f27] bg-[#0a0a0e]/80 max-w-[min(45vw,220px)] sm:max-w-[min(38vw,280px)]"
                title={parsedContext.full}
              >
                <span className="text-[8px] font-semibold uppercase tracking-[0.14em] text-zinc-500 flex-shrink-0">
                  {parsedContext.kind === 'ca' ? copy.labelCa : copy.labelUrl}
                </span>
                <span className="font-mono text-[9px] sm:text-[10px] text-zinc-300 truncate tabular-nums">
                  {parsedContext.display}
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(parsedContext.full);
                    } catch { /* noop */ }
                  }}
                  className="flex-shrink-0 p-0.5 text-zinc-600 hover:text-zinc-300 transition-colors"
                  aria-label={copy.copyLabel}
                >
                  <Copy className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
                </button>
              </div>
            )}
          </div>

          <div className="hidden md:flex items-center gap-8">
            {NAV_LINKS.map((link) => {
              const active = pathname === link.href;
              return (
                <Link
                  key={link.label}
                  href={link.href}
                  className={cn(
                    'text-[10px] font-semibold uppercase tracking-[0.24em] transition-colors duration-150 relative',
                    active
                      ? 'text-white'
                      : 'text-zinc-500 hover:text-zinc-200',
                  )}
                >
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={`${locale}-${link.href}`}
                      initial={{ opacity: 0, y: 8, filter: 'blur(4px)' }}
                      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                      exit={{ opacity: 0, y: -8, filter: 'blur(4px)' }}
                      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                      className="block"
                    >
                      {link.label}
                    </motion.span>
                  </AnimatePresence>
                  {active && (
                    <span className="absolute -bottom-1 left-0 right-0 h-px bg-red-500/70 rounded-full" />
                  )}
                </Link>
              );
            })}
          </div>

          <div className="flex items-center gap-5">
            <ConnectWalletButton showMintNudge={false} />
            <a
              href="https://x.com/larpscanbnb"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="LARPSCAN on X"
              className="text-zinc-500 hover:text-white transition-colors duration-150"
            >
              <XIcon />
            </a>
            <div className="relative flex items-center border border-[#1f1f27] rounded-sm overflow-hidden bg-[#0a0a0e]">
              <motion.div
                className="absolute top-0 bottom-0 w-1/2 bg-[#16161d]"
                animate={{ x: locale === 'en' ? '0%' : '100%' }}
                transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
              />
              <button
                onClick={() => setLocale('en')}
                className={cn(
                  'relative z-10 px-2.5 py-2 text-[10px] font-semibold uppercase tracking-[0.2em] transition-colors',
                  locale === 'en' ? 'text-white' : 'text-zinc-500 hover:text-zinc-300',
                )}
              >
                EN
              </button>
              <button
                onClick={() => setLocale('zh-TW')}
                className={cn(
                  'relative z-10 px-2.5 py-2 text-[10px] font-semibold uppercase tracking-[0.2em] transition-colors',
                  locale === 'zh-TW' ? 'text-white' : 'text-zinc-500 hover:text-zinc-300',
                )}
              >
                zh
              </button>
            </div>
            <Link
              href="/dashboard"
              onClick={() => {
                if (typeof window !== 'undefined') {
                  window.sessionStorage.setItem('larpscan_dashboard_entry', '1');
                }
              }}
              className="text-[10px] font-semibold uppercase tracking-[0.22em] px-5 py-2.5 rounded-sm bg-red-600 text-white hover:bg-red-500 transition-all duration-150"
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={`open-${locale}`}
                  initial={{ opacity: 0, y: 8, filter: 'blur(4px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, y: -8, filter: 'blur(4px)' }}
                  transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                  className="block"
                >
                  {copy.open}
                </motion.span>
              </AnimatePresence>
            </Link>
          </div>
        </div>
      </div>
    </nav>
  );
}
