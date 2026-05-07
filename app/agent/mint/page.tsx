'use client';

import { useState, useEffect, useRef } from 'react';
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { motion, AnimatePresence } from 'framer-motion';
import Link from 'next/link';
import { Navbar } from '@/components/navbar';
import { NFA_ABI, NFA_CONTRACT_ADDRESS, PLATFORM_LOGIC_ADDRESS } from '@/lib/nfa-contract';
import { LARPSCAN_SYSTEM_PROMPT } from '@/lib/llm';
import { cn, truncateAddress } from '@/lib/utils';

// ERC-721 Transfer event topic (keccak256 of Transfer(address,address,uint256))
const ERC721_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const PRESETS = [
  {
    id:    'larpscan',
    label: 'Larpscan',
    desc:  'The same AI that powers Larpscan verification — blockchain analyst and auditor.',
  },
  {
    id:    'custom',
    label: 'Custom',
    desc:  'Write your own system prompt from scratch.',
  },
] as const;

type PresetId = typeof PRESETS[number]['id'];

// ── Steps ────────────────────────────────────────────────────────────────────
const STEPS = [
  { id: 'identity',    label: 'Identity' },
  { id: 'personality', label: 'Personality' },
  { id: 'review',      label: 'Review & Mint' },
] as const;

type Step = typeof STEPS[number]['id'];

// ── Form state ───────────────────────────────────────────────────────────────
interface AgentForm {
  name:         string;
  description:  string;
  image:        string;
  presetId:     PresetId;
  systemPrompt: string;  // only used when presetId === 'custom'
}

const DEFAULT_FORM: AgentForm = {
  name:         '',
  description:  '',
  image:        '',
  presetId:     'larpscan',
  systemPrompt: '',
};

// ── Reusable sub-components ──────────────────────────────────────────────────
function StepBar({ current }: { current: number }) {
  return (
    <div className="flex items-center w-full mb-8">
      {STEPS.map((s, i) => (
        <div key={s.id} className={cn('flex items-center', i < STEPS.length - 1 ? 'flex-1' : '')}>
          <div className="flex items-center gap-2 shrink-0">
            <div className={cn(
              'w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 transition-colors',
              i < current  ? 'bg-red-600 text-white'
              : i === current ? 'border border-red-600 bg-red-600/10 text-red-400'
              : 'border border-[#2a2a35] bg-[#16161d] text-zinc-600',
            )}>
              {i < current ? '✓' : i + 1}
            </div>
            <span className={cn(
              'text-[10px] font-semibold uppercase tracking-[0.14em] whitespace-nowrap',
              i === current ? 'text-white' : i < current ? 'text-zinc-500' : 'text-zinc-700',
            )}>
              {s.label}
            </span>
          </div>
          {i < STEPS.length - 1 && (
            <div className={cn('h-px flex-1 mx-3', i < current ? 'bg-red-600/40' : 'bg-[#2a2a35]')} />
          )}
        </div>
      ))}
    </div>
  );
}

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-400 mb-1.5">
      {children}{required && <span className="text-red-500 ml-1">*</span>}
    </label>
  );
}

function TextInput({ value, onChange, placeholder, maxLength }: {
  value: string; onChange: (v: string) => void; placeholder?: string; maxLength?: number;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      maxLength={maxLength}
      className="w-full bg-[#0d0d12] border border-[#1f1f27] rounded-sm px-3 py-2.5 text-[13px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
    />
  );
}

function TextArea({ value, onChange, placeholder, rows = 4 }: {
  value: string; onChange: (v: string) => void; placeholder?: string; rows?: number;
}) {
  return (
    <textarea
      rows={rows}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full bg-[#0d0d12] border border-[#1f1f27] rounded-sm px-3 py-2.5 text-[13px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors resize-none"
    />
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-6 py-2.5 border-b border-[#16161d] last:border-0">
      <span className="text-[12px] text-zinc-500 shrink-0 w-24">{label}</span>
      <span className="text-[12px] text-zinc-200 text-right font-mono break-all">{value || '—'}</span>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function MintAgentPage() {
  const { address, isConnected } = useAccount();
  const [step, setStep]           = useState<Step>('identity');
  const [form, setForm]           = useState<AgentForm>(DEFAULT_FORM);
  const [mintError, setMintError] = useState<string | null>(null);
  const [isSaving, setIsSaving]   = useState(false);
  const [saved, setSaved]         = useState(false);
  const recordedRef               = useRef(false);  // prevent double-recording in StrictMode

  const stepIndex = STEPS.findIndex(s => s.id === step);
  const set = <K extends keyof AgentForm>(k: K, v: AgentForm[K]) => setForm(f => ({ ...f, [k]: v }));

  // ── Contract reads ────────────────────────────────────────────────────────
  const { data: agentBalance } = useReadContract({
    address: NFA_CONTRACT_ADDRESS, abi: NFA_ABI, functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });
  const hasAgent = typeof agentBalance === 'bigint' && agentBalance > 0n;

  // createAgent is nonpayable — always free, no fee required

  // ── Contract write ────────────────────────────────────────────────────────
  const { writeContract, data: txHash, isPending: isMinting } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isMintedOnChain, data: receipt } =
    useWaitForTransactionReceipt({ hash: txHash });

  // ── Record agent in Supabase after on-chain confirm ───────────────────────
  useEffect(() => {
    if (!isMintedOnChain || !receipt || !address || recordedRef.current) return;
    recordedRef.current = true;

    // Parse tokenId from ERC-721 Transfer event (4th topic = indexed tokenId)
    const transferLog = receipt.logs.find(
      l =>
        l.address.toLowerCase() === NFA_CONTRACT_ADDRESS.toLowerCase() &&
        l.topics[0] === ERC721_TRANSFER_TOPIC,
    );
    const tokenId = transferLog?.topics[3]
      ? BigInt(transferLog.topics[3]).toString()
      : undefined;

    setIsSaving(true);
    fetch('/api/agent/record', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerAddress: address,
        txHash:       receipt.transactionHash,
        tokenId,
        name:         form.name,
        description:  form.description,
        image:        form.image || null,
        personality:  form.presetId,
        systemPrompt: form.presetId === 'custom' ? form.systemPrompt : undefined,
      }),
    })
      .catch(err => console.error('[mint] record error:', err))
      .finally(() => { setIsSaving(false); setSaved(true); });
  }, [isMintedOnChain, receipt, address, form]);

  const success = saved || (isMintedOnChain && !isSaving);

  const handleMint = () => {
    if (!address) return;
    setMintError(null);

    const resolvedPrompt = form.presetId === 'larpscan' ? LARPSCAN_SYSTEM_PROMPT : form.systemPrompt;

    // Build ERC-721 compatible metadata URI (base64 data URI — no external infra needed)
    const metadata = {
      name:        form.name,
      description: form.description,
      image:       form.image || 'https://larpscan.sh/icon.png',
    };
    const metadataURI = `data:application/json;base64,${btoa(JSON.stringify(metadata))}`;

    try {
      writeContract({
        address:      NFA_CONTRACT_ADDRESS,
        abi:          NFA_ABI,
        functionName: 'createAgent',
        args: [
          address,                  // to: mint to the connected wallet
          PLATFORM_LOGIC_ADDRESS,   // logicAddress: Larpscan PlatformConnectorLogic
          metadataURI,
          {
            persona:      resolvedPrompt,
            experience:   form.description,
            voiceHash:    '',
            animationURI: '',
            vaultURI:     '',
            vaultHash:    '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
          },
        ],
      });
    } catch (e) {
      setMintError(e instanceof Error ? e.message : 'Transaction failed');
    }
  };

  const canNext: Record<Step, boolean> = {
    identity:    !!form.name.trim() && !!form.description.trim(),
    personality: form.presetId === 'larpscan' || !!form.systemPrompt.trim(),
    review:      true,
  };

  return (
    <div className="min-h-screen bg-[#050507] text-white">
      <Navbar />

      {/* Playwright / crawler metadata */}
      <div
        data-testid="mint-form-meta"
        data-steps={STEPS.map(s => s.label).join(',')}
        data-personalities={PRESETS.map(p => p.id).join(',')}
        aria-hidden="true"
        className="hidden"
      />

      <main className="pt-28 pb-20 px-4 sm:px-6 max-w-[620px] mx-auto">
        {/* Header */}
        <div className="mb-8">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-500 mb-3">
            BAP-578 · BNB Chain
          </p>
          <h1 className="text-[28px] sm:text-[32px] font-bold text-white mb-2">
            Create Your AI Agent
          </h1>
          <p className="text-zinc-500 text-[13px]">
            Configure your Non-Fungible Agent — it will live on BNB Chain under your wallet.
          </p>
        </div>

        {/* ── Not connected ──────────────────────────────────────────────── */}
        {!isConnected ? (
          <div
            data-testid="connect-wallet-prompt"
            className="border border-[#1f1f27] rounded-xl bg-[#0a0a0e] p-12 flex flex-col items-center text-center"
          >
            <div className="w-10 h-10 rounded-full border border-[#2a2a35] flex items-center justify-center mb-5">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-500">
                <rect x="2" y="7" width="20" height="14" rx="2" />
                <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
                <line x1="12" y1="12" x2="12" y2="16" />
                <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
              </svg>
            </div>
            <p className="text-white text-[14px] font-semibold mb-1">Connect your wallet</p>
            <p className="text-zinc-500 text-[12px] mb-7 max-w-[240px]">
              You need a Web3 wallet to mint your agent on BNB Chain.
            </p>
            <ConnectButton />
          </div>

        ) : success ? (
          /* ── Success ──────────────────────────────────────────────────── */
          <motion.div
            data-testid="mint-success"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="border border-emerald-700/40 rounded-xl bg-emerald-900/10 p-12 flex flex-col items-center text-center"
          >
            <p className="text-emerald-400 font-bold text-[18px] mb-2">Agent Minted ✓</p>
            <p className="text-zinc-300 text-[14px] font-semibold mb-1">{form.name}</p>
            <p className="text-zinc-600 text-[12px] mb-8">
              Your agent is live on BNB Chain.
            </p>
            <Link
              href="/dashboard"
              data-testid="go-to-dashboard-btn"
              className="text-[10px] font-semibold uppercase tracking-[0.22em] px-8 py-3.5 rounded-sm bg-red-600 text-white hover:bg-red-500 transition-all"
            >
              Go to Dashboard →
            </Link>
          </motion.div>

        ) : (
          /* ── Form card ────────────────────────────────────────────────── */
          <div className="border border-[#1f1f27] rounded-xl bg-[#0a0a0e] overflow-hidden">
            <div className="p-6 sm:p-8">
              <StepBar current={stepIndex} />

              <AnimatePresence mode="wait">
                <motion.div
                  key={step}
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -12 }}
                  transition={{ duration: 0.16 }}
                >

                  {/* Step 1 — Identity */}
                  {step === 'identity' && (
                    <div className="space-y-5">
                      <div>
                        <h2 className="text-[15px] font-bold text-white mb-1">Identity</h2>
                        <p className="text-zinc-600 text-[12px]">
                          The public face of your agent — stored on-chain and shown in marketplaces.
                        </p>
                      </div>

                      <div>
                        <FieldLabel required>Agent Name</FieldLabel>
                        <TextInput
                          value={form.name}
                          onChange={v => set('name', v)}
                          placeholder="e.g. VerifyBot Alpha"
                          maxLength={32}
                        />
                        <p className="text-[10px] text-zinc-600 mt-1">{form.name.length}/32 characters</p>
                      </div>

                      <div>
                        <FieldLabel required>Description</FieldLabel>
                        <TextArea
                          value={form.description}
                          onChange={v => set('description', v)}
                          placeholder="What does this agent do? Shown in the NFT metadata."
                          rows={3}
                        />
                      </div>

                      <div>
                        <FieldLabel>Image URL</FieldLabel>
                        <TextInput
                          value={form.image}
                          onChange={v => set('image', v)}
                          placeholder="https://… or ipfs://…  (leave blank for default)"
                        />
                      </div>
                    </div>
                  )}

                  {/* Step 2 — Personality */}
                  {step === 'personality' && (
                    <div className="space-y-5">
                      <div>
                        <h2 className="text-[15px] font-bold text-white mb-1">Personality</h2>
                        <p className="text-zinc-600 text-[12px]">
                          Use the Larpscan platform personality or define your own.
                        </p>
                      </div>

                      <div className="space-y-2">
                        {PRESETS.map(p => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => set('presetId', p.id as PresetId)}
                            className={cn(
                              'w-full text-left px-4 py-3.5 rounded-sm border transition-colors',
                              form.presetId === p.id
                                ? 'border-red-600/60 bg-red-600/10'
                                : 'border-[#1f1f27] bg-[#0d0d12] hover:border-zinc-600',
                            )}
                          >
                            <p className={cn('text-[13px] font-semibold', form.presetId === p.id ? 'text-white' : 'text-zinc-300')}>
                              {p.label}
                            </p>
                            <p className="text-[11px] text-zinc-500 mt-0.5">{p.desc}</p>
                          </button>
                        ))}
                      </div>

                      {form.presetId === 'custom' && (
                        <div>
                          <FieldLabel required>System Prompt</FieldLabel>
                          <TextArea
                            value={form.systemPrompt}
                            onChange={v => set('systemPrompt', v)}
                            placeholder="The core instructions guiding your agent's behaviour…"
                            rows={5}
                          />
                          <p className="text-[10px] text-zinc-600 mt-1">
                            Stored on-chain as your agent's identity.
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Step 3 — Review & Mint */}
                  {step === 'review' && (
                    <div className="space-y-4">
                      <div>
                        <h2 className="text-[15px] font-bold text-white mb-1">Review & Mint</h2>
                        <p className="text-zinc-600 text-[12px]">
                          Review your agent before minting. You can update metadata later from the <span className="text-zinc-400">Agents</span> page.
                        </p>
                      </div>

                      <div className="border border-[#1a1a22] rounded-lg p-4">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500 mb-1">Identity</p>
                        <ReviewRow label="Name"        value={form.name} />
                        <ReviewRow label="Description" value={form.description.length > 80 ? form.description.slice(0, 80) + '…' : form.description} />
                        <ReviewRow label="Image"       value={form.image || 'default'} />
                      </div>

                      <div className="border border-[#1a1a22] rounded-lg p-4">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500 mb-1">Personality</p>
                        <ReviewRow label="Type"   value={form.presetId === 'larpscan' ? 'Larpscan Platform' : 'Custom'} />
                        <ReviewRow
                          label="Prompt"
                          value={
                            form.presetId === 'larpscan'
                              ? 'Larpscan blockchain analyst & auditor (platform default)'
                              : form.systemPrompt.length > 90
                                ? form.systemPrompt.slice(0, 90) + '…'
                                : form.systemPrompt
                          }
                        />
                      </div>

                      <div className="border border-[#1a1a22] rounded-lg p-4">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500 mb-1">On-chain config</p>
                        <ReviewRow label="Standard" value="BAP-578 NFA" />
                        <ReviewRow label="Memory"   value="Merkle Tree Learning" />
                        <ReviewRow label="Chain"    value="BNB Chain" />
                        <ReviewRow label="Owner"    value={address ? truncateAddress(address, 6, 4) : '—'} />
                      </div>

                      <div className="border border-[#1a1a22] rounded-lg px-4 py-3 flex items-center justify-between">
                        <span className="text-[12px] text-zinc-500">Mint fee</span>
                        <span className="font-mono text-[15px] font-bold text-emerald-400">FREE</span>
                      </div>

                      <button
                        data-testid="mint-btn"
                        onClick={handleMint}
                        disabled={isMinting || isConfirming || isSaving || !form.name.trim()}
                        className={cn(
                          'w-full text-[11px] font-semibold uppercase tracking-[0.22em] py-4 rounded-sm transition-all',
                          isMinting || isConfirming || isSaving
                            ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                            : 'bg-red-600 text-white hover:bg-red-500',
                        )}
                      >
                        {isMinting      ? 'Confirm in wallet…'
                         : isConfirming ? 'Confirming on-chain…'
                         : isSaving     ? 'Saving…'
                         : 'Mint Agent — Free'}
                      </button>

                      {mintError && (
                        <p data-testid="mint-error" className="text-red-400 text-[11px]">{mintError}</p>
                      )}
                    </div>
                  )}

                </motion.div>
              </AnimatePresence>
            </div>

            {/* ── Footer nav ──────────────────────────────────────────────── */}
            <div className="px-6 sm:px-8 py-4 border-t border-[#1a1a22] flex items-center justify-between">
              <button
                type="button"
                onClick={() => setStep(STEPS[Math.max(0, stepIndex - 1)].id as Step)}
                disabled={stepIndex === 0}
                className="text-[10px] font-semibold uppercase tracking-[0.2em] px-5 py-2.5 rounded-sm border border-[#2a2a35] text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              >
                ← Back
              </button>

              {step !== 'review' && (
                <button
                  type="button"
                  onClick={() => setStep(STEPS[Math.min(STEPS.length - 1, stepIndex + 1)].id as Step)}
                  disabled={!canNext[step]}
                  className="text-[10px] font-semibold uppercase tracking-[0.2em] px-6 py-2.5 rounded-sm bg-red-600 text-white hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  Next →
                </button>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
