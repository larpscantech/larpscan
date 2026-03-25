import { Globe, Twitter, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { truncateAddressPump } from '@/lib/utils';
import type { TokenProject } from '@/lib/types';

interface TokenOverviewCardProps {
  project: TokenProject | null;
}

function CopyButton({ text }: { text: string }) {
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // silently fail
    }
  }
  return (
    <button
      onClick={handleCopy}
      className="text-zinc-600 hover:text-zinc-400 transition-colors ml-1.5"
      title="Copy address"
    >
      <Copy className="w-3 h-3" />
    </button>
  );
}

function SkeletonLine({ width = 'full' }: { width?: string }) {
  return (
    <div
      className={cn(
        'h-3.5 rounded bg-cv-elevated animate-pulse',
        width === 'full' ? 'w-full' : width,
      )}
    />
  );
}

export function TokenOverviewCard({ project }: TokenOverviewCardProps) {
  return (
    <div className="rounded-xl border border-cv-border bg-cv-card p-5">
      <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-4">
        Token Overview
      </p>

      {!project ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-cv-elevated animate-pulse" />
            <div className="space-y-1.5 flex-1">
              <SkeletonLine width="w-24" />
              <SkeletonLine width="w-16" />
            </div>
          </div>
          <p className="text-xs text-zinc-600 mt-3">Token metadata will appear shortly.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Identity */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-cv-red/10 border border-cv-red/20 flex items-center justify-center flex-shrink-0">
              <span className="text-sm font-bold text-cv-red">
                {project.logoInitial ?? project.name[0]}
              </span>
            </div>
            <div>
              <p className="text-sm font-semibold text-white leading-tight">
                {project.name}
              </p>
              <p className="text-xs text-zinc-500">{project.ticker}</p>
            </div>
          </div>

          {/* Links */}
          <div className="space-y-2.5">
            <div className="flex items-center gap-2 text-xs">
              <Globe className="w-3.5 h-3.5 text-zinc-600 flex-shrink-0" />
              <a
                href={`https://${project.website}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-zinc-400 hover:text-white transition-colors font-mono"
              >
                {project.website}
              </a>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <Twitter className="w-3.5 h-3.5 text-zinc-600 flex-shrink-0" />
              <a
                href={`https://x.com/${project.xHandle.replace('@', '')}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-zinc-400 hover:text-white transition-colors font-mono"
              >
                {project.xHandle}
              </a>
            </div>
          </div>

          {/* Address */}
          <div className="pt-1 border-t border-cv-border">
            <div className="flex items-center gap-1">
              <span className="font-mono text-[11px] text-zinc-500">
                {truncateAddressPump(project.contractAddress)}
              </span>
              <CopyButton text={project.contractAddress} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
