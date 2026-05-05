'use client';

import { Navbar } from '@/components/navbar';

export default function MintAgentPage() {
  return (
    <div className="min-h-screen bg-[#050507] text-white">
      <Navbar />
      <main className="flex flex-col items-center justify-center min-h-screen px-6 text-center">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-500 mb-4">
          BAP-578 · BNB Chain
        </p>
        <h1 className="text-[32px] sm:text-[40px] font-bold text-white mb-3">
          Coming Soon
        </h1>
        <p className="text-zinc-500 text-[14px] max-w-[340px]">
          Non-Fungible Agents are on the way. Your on-chain AI agent will live under your wallet on BNB Chain.
        </p>
      </main>
    </div>
  );
}
