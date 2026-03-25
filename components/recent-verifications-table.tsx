'use client';

import { Copy } from 'lucide-react';
import { StatusBadge } from './status-badge';
import { truncateAddressPump } from '@/lib/utils';
import type { RecentVerification } from '@/lib/types';
import { useLocale } from '@/components/locale-provider';

interface RecentVerificationsTableProps {
  verifications: RecentVerification[];
}

function CopyBtn({ address }: { address: string }) {
  async function copy() {
    try { await navigator.clipboard.writeText(address); } catch { /* noop */ }
  }
  return (
    <button onClick={copy} className="text-zinc-700 hover:text-zinc-400 transition-colors ml-1.5">
      <Copy className="w-3 h-3" />
    </button>
  );
}

function QABar({ verified, total }: { verified: number; total: number }) {
  const pct = total > 0 ? Math.round((verified / total) * 100) : 0;
  const barColor =
    pct === 100
      ? 'bg-emerald-600/70'
      : pct === 0
      ? 'bg-[#b91c1c]/70'
      : 'bg-amber-600/70';
  const textColor =
    pct === 100 ? 'text-emerald-400' : pct === 0 ? 'text-red-400' : 'text-amber-400';

  return (
    <div className="flex items-center gap-3">
      <div className="w-20 h-1.5 rounded-full bg-cv-elevated overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`font-mono text-[11px] font-bold tabular-nums ${textColor}`}>
        {verified}/{total}
      </span>
    </div>
  );
}

export function RecentVerificationsTable({ verifications }: RecentVerificationsTableProps) {
  const { locale } = useLocale();
  const isZh = locale === 'zh-TW';
  const COL_HEADERS = isZh
    ? ['代幣', '合約地址', '狀態', 'QA 分數', '預估時間']
    : ['Token', 'Contract Address', 'Status', 'QA Score', 'Est. Time'];

  return (
    <div className="rounded-sm border border-[#1c1c22] bg-[#09090d] overflow-hidden">
      {/* Panel header */}
      <div className="px-7 py-5 border-b border-[#1f1f27] flex items-center justify-between">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-widest text-zinc-400">
            {isZh ? '近期掃描' : 'Recent Scans'}
          </p>
          <p className="text-xs text-zinc-700 mt-1">
            {isZh
              ? '過去 24 小時內的執行中與已完成驗證'
              : 'Active jobs and completed verifications from the past 24 hours'}
          </p>
        </div>
        <span className="text-[10px] font-mono font-bold text-zinc-700 bg-[#101015] border border-[#1f1f27] rounded-sm px-3 py-1.5">
          {verifications.length} {isZh ? '總計' : 'total'}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[#1f1f27]">
              {COL_HEADERS.map((col) => (
                <th
                  key={col}
                  className="px-7 py-3.5 text-left text-[9px] font-bold uppercase tracking-widest text-zinc-700"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {verifications.map((v, i) => (
              <tr
                key={v.id}
                className={[
                  'group transition-all duration-150 hover:bg-[#101015]',
                  i < verifications.length - 1 ? 'border-b border-[#1f1f27]' : '',
                ].join(' ')}
              >
                {/* Token */}
                <td className="px-7 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-sm bg-[#101015] border border-[#1f1f27] flex items-center justify-center flex-shrink-0 group-hover:border-zinc-600/60 transition-colors">
                      <span className="text-[10px] font-bold text-zinc-500">
                        {v.project.logoInitial ?? v.project.name[0]}
                      </span>
                    </div>
                    <div>
                      <p className="text-[13px] font-semibold text-white leading-tight">
                        {v.project.name}
                      </p>
                      <p className="text-[10px] text-zinc-600 font-mono mt-0.5">
                        {v.project.website}
                      </p>
                    </div>
                  </div>
                </td>

                {/* Address */}
                <td className="px-7 py-4">
                  <div className="flex items-center">
                    <span className="font-mono text-[11px] text-zinc-500">
                      {truncateAddressPump(v.project.contractAddress)}
                    </span>
                    <CopyBtn address={v.project.contractAddress} />
                  </div>
                </td>

                {/* Status */}
                <td className="px-7 py-4">
                  <StatusBadge
                    variant={v.status === 'in_progress' ? 'in-progress' : 'complete'}
                  />
                </td>

                {/* QA Score */}
                <td className="px-7 py-4">
                  <QABar verified={v.claimsVerified} total={v.claimsTotal} />
                </td>

                {/* Est. Time */}
                <td className="px-7 py-4">
                  <span className="font-mono text-[11px] text-zinc-600 tabular-nums">
                    {v.estTime ?? '—'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
