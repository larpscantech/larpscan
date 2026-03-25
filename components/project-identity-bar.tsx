'use client';

import { Globe, Copy } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { truncateAddressPump } from '@/lib/utils';
import type { TokenProject } from '@/lib/types';
import { useLocale } from '@/components/locale-provider';

interface ProjectIdentityBarProps {
  project: TokenProject | null; // null = skeleton loading state
  claimCount?: number;
}

function XIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-zinc-700 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function CopyAddress({ address }: { address: string }) {
  async function copy() {
    try { await navigator.clipboard.writeText(address); } catch { /* noop */ }
  }
  return (
    <button onClick={copy} className="text-zinc-700 hover:text-zinc-400 transition-colors ml-1.5 flex-shrink-0">
      <Copy className="w-3 h-3" />
    </button>
  );
}

function Skeleton({ w, h = 'h-3' }: { w: string; h?: string }) {
  return <div className={`${h} ${w} rounded-sm bg-[#111117] animate-pulse`} />;
}

export function ProjectIdentityBar({ project, claimCount }: ProjectIdentityBarProps) {
  const { locale } = useLocale();
  const isZh = locale === 'zh-TW';

  const normalizeWebsiteUrl = (website: string) =>
    /^https?:\/\//i.test(website) ? website : `https://${website}`;

  return (
    <div className="rounded-sm border border-[#1c1c22] bg-[#09090d] mb-8 overflow-hidden">
      <div className="h-[2px] w-full bg-gradient-to-r from-[#b91c1c]/80 via-[#dc2626]/30 to-transparent" />

      <div className="px-7 py-4 flex flex-wrap items-center gap-6 min-h-[68px]">
        <AnimatePresence mode="wait">
          {project === null ? (
            <motion.div
              key="skeleton"
              initial={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="flex flex-wrap items-center gap-6 w-full"
            >
              {/* Logo skeleton */}
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 rounded-sm bg-[#111117] border border-[#1c1c22] animate-pulse" />
                <div className="space-y-2">
                  <Skeleton w="w-20" h="h-4" />
                  <Skeleton w="w-10" />
                </div>
              </div>
              <div className="h-8 w-px bg-[#1f1f27] hidden sm:block" />
              <Skeleton w="w-36" />
              <Skeleton w="w-28" />
              <Skeleton w="w-32" />
              <div className="ml-auto">
                <Skeleton w="w-24" />
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="content"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
              className="flex flex-wrap items-center gap-6 w-full"
            >
              {/* Project identity */}
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 rounded-sm bg-[#1c0808] border border-[#b91c1c]/25 flex items-center justify-center flex-shrink-0">
                  <span className="text-sm font-bold text-[#dc2626]">
                    {project.logoInitial ?? project.name[0]}
                  </span>
                </div>
                <div>
                  <p className="text-[15px] font-bold text-white leading-tight tracking-tight">
                    {project.name}
                  </p>
                  <p className="text-[10px] font-mono text-zinc-600 mt-0.5">{project.ticker}</p>
                </div>
              </div>

              <div className="h-8 w-px bg-[#1f1f27] hidden sm:block" />

              <a
                href={normalizeWebsiteUrl(project.website)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-200 transition-colors font-mono"
              >
                <Globe className="w-3.5 h-3.5 text-zinc-700 flex-shrink-0" />
                {project.website}
              </a>

              <a
                href={`https://x.com/${project.xHandle.replace('@', '')}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-200 transition-colors font-mono"
              >
                <XIcon />
                {project.xHandle}
              </a>

              <div className="flex items-center font-mono text-[11px] text-zinc-600">
                {truncateAddressPump(project.contractAddress)}
                <CopyAddress address={project.contractAddress} />
              </div>

              {claimCount !== undefined && (
                <div className="ml-auto flex items-center gap-3">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-600">
                    {claimCount}{' '}
                    {isZh
                      ? `項宣稱已提取`
                      : `${claimCount === 1 ? 'claim' : 'claims'} extracted`}
                  </span>
                  <span className="text-[10px] font-mono font-bold text-zinc-700 border border-[#1f1f27] rounded-sm px-2 py-1 bg-[#101015]">
                    BNB Chain
                  </span>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
