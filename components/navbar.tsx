'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { useLocale } from '@/components/locale-provider';

function Logo() {
  return (
    <div className="flex items-center gap-3">
      <div className="relative w-6 h-6 flex-shrink-0">
        <div className="absolute inset-0 rounded-sm border border-zinc-700" />
        <div className="absolute top-0.5 left-0.5 right-0.5 bottom-0.5 rounded-[2px] border border-zinc-600" />
        <div className="absolute top-1 left-1 w-2 h-2 bg-red-600 rounded-[1px]" />
      </div>
      <span className="text-[13px] font-bold tracking-tight">
        <span className="text-white">LARP</span>
        <span className="text-red-500">SCAN</span>
      </span>
    </div>
  );
}

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();
  const { locale, setLocale } = useLocale();

  const copy = locale === 'zh-TW'
    ? {
        home: '首頁',
        docs: '文件',
        open: '進入儀表板',
      }
    : {
        home: 'Home',
        docs: 'Docs',
        open: 'Enter Dashboard',
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
          ? 'bg-[#050507]/96 border-b border-[#1a1a20]'
          : 'bg-[#050507]/88 border-b border-transparent',
      )}
    >
      <div className="max-w-[1240px] mx-auto px-8">
        <div className="flex items-center justify-between h-[64px]">
          <Link href="/home" className="hover:opacity-80 transition-opacity duration-150">
            <Logo />
          </Link>

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
