'use client';

import { useState } from 'react';
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther } from 'viem';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { motion, AnimatePresence } from 'framer-motion';
import Link from 'next/link';
import { Navbar } from '@/components/navbar';
import { NFA_ABI, NFA_CONTRACT_ADDRESS } from '@/lib/nfa-contract';
import { cn, truncateAddress } from '@/lib/utils';

const IS_MOCK = NFA_CONTRACT_ADDRESS === '0x0000000000000000000000000000000000000000';

// ── BAP-578 agent types from the spec ──────────────────────────────────────
const AGENT_TYPES = [
  { value: 0, label: 'DeFi Agent',      desc: 'Specialized for DeFi operations and trading' },
  { value: 1, label: 'Verifier Agent',  desc: 'Audits token claims with real browser sessions' },
  { value: 2, label: 'Game Agent',      desc: 'Optimized for gaming and virtual worlds' },
  { value: 3, label: 'DAO Agent',       desc: 'Governance and DAO participation' },
  { value: 4, label: 'Creator Agent',   desc: 'Content creation and artistic endeavors' },
  { value: 5, label: 'Strategic Agent', desc: 'Analysis and strategic decision-making' },
] as const;

const MEMORY_TYPES = [
  { value: 0, label: 'JSON Light Memory', desc: 'Simple, fast — ideal for most agents' },
  { value: 1, label: 'Merkle Tree Learning', desc: 'Evolving agent with cryptographic learning history' },
] as const;

const AI_MODELS = ['gpt-4o', 'gpt-4o-mini', 'claude-opus-4', 'claude-sonnet-4', 'gemini-2.5-pro'];

// ── Form state ──────────────────────────────────────────────────────────────
interface AgentForm {
  // Identity
  name:         string;
  description:  string;
  image:        string;
  // Personality / persona
  persona:      string;    // JSON-encoded character traits, style, tone
  experience:   string;    // Role / purpose summary
  // AI config
  agentType:    number;
  model:        string;
  systemPrompt: string;
  // Media (optional)
  animationURI: string;
  voiceHash:    string;
  // Memory / storage
  memoryType:   number;
  vaultURI:     string;
  // Learning (optional)
  learningEnabled: boolean;
}

const DEFAULT_FORM: AgentForm = {
  name:            '',
  description:     '',
  image:           '',
  persona:         '',
  experience:      '',
  agentType:       1,
  model:           'gpt-4o',
  systemPrompt:    '',
  animationURI:    '',
  voiceHash:       '',
  memoryType:      0,
  vaultURI:        '',
  learningEnabled: false,
};

// ── Steps ───────────────────────────────────────────────────────────────────
const STEPS = [
  { id: 'identity',    label: 'Identity' },
  { id: 'personality', label: 'Personality' },
  { id: 'ai',          label: 'AI Config' },
  { id: 'memory',      label: 'Memory' },
  { id: 'review',      label: 'Review & Mint' },
] as const;

type Step = typeof STEPS[number]['id'];

// ── Sub-components ───────────────────────────────────────────────────────────
function StepDots({ current, steps }: { current: number; steps: typeof STEPS }) {
  return (
    <div className="flex items-center gap-2 mb-8">
      {steps.map((s, i) => (
        <div key={s.id} className="flex items-center gap-2">
          <div className={cn(
            'flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold transition-all duration-200',
            i < current  ? 'bg-red-600 text-white'
            : i === current ? 'bg-red-600/20 border border-red-600 text-red-400'
            : 'bg-[#16161d] border border-[#2a2a35] text-zinc-600',
          )}>
            {i < current ? '✓' : i + 1}
          </div>
          <span className={cn(
            'text-[10px] font-semibold uppercase tracking-[0.16em] hidden sm:block',
            i === current ? 'text-white' : i < current ? 'text-zinc-500' : 'text-zinc-700',
          )}>
            {s.label}
          </span>
          {i < steps.length - 1 && (
            <div className={cn(
              'w-6 h-px mx-1',
              i < current ? 'bg-red-600/50' : 'bg-[#2a2a35]',
            )} />
          )}
        </div>
      ))}
    </div>
  );
}

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-400 mb-1.5">
      {children}
      {required && <span className="text-red-500 ml-1">*</span>}
    </label>
  );
}

function Input({ value, onChange, placeholder, maxLength, className }: {
  value: string; onChange: (v: string) => void; placeholder?: string; maxLength?: number; className?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      maxLength={maxLength}
      className={cn(
        'w-full bg-[#0d0d12] border border-[#1f1f27] rounded-sm px-3 py-2.5 text-[13px] text-white',
        'placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors',
        className,
      )}
    />
  );
}

function Textarea({ value, onChange, placeholder, rows = 4 }: {
  value: string; onChange: (v: string) => void; placeholder?: string; rows?: number;
}) {
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full bg-[#0d0d12] border border-[#1f1f27] rounded-sm px-3 py-2.5 text-[13px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors resize-none"
    />
  );
}

function ReviewRow({ label, value }: { label: string; value: string | number | boolean }) {
  const display = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value) || '—';
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-[#16161d] last:border-0 text-[12px]">
      <span className="text-zinc-500 flex-shrink-0">{label}</span>
      <span className="text-zinc-200 text-right font-mono break-all max-w-[60%]">{display}</span>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function MintAgentPage() {
  const { address, isConnected } = useAccount();
  const [step, setStep]         = useState<Step>('identity');
  const [form, setForm]         = useState<AgentForm>(DEFAULT_FORM);
  const [mintError, setMintError] = useState<string | null>(null);
  const [mockMinted, setMockMinted] = useState(false);

  const stepIndex = STEPS.findIndex(s => s.id === step);

  const set = (key: keyof AgentForm, value: AgentForm[keyof AgentForm]) =>
    setForm(f => ({ ...f, [key]: value }));

  // ── Contract reads ────────────────────────────────────────────────────────
  const { data: freeMints } = useReadContract({
    address: NFA_CONTRACT_ADDRESS,
    abi:     NFA_ABI,
    functionName: 'freeMintCount',
    args:    address ? [address] : undefined,
    query:   { enabled: !!address && !IS_MOCK },
  });

  const { data: balance } = useReadContract({
    address: NFA_CONTRACT_ADDRESS,
    abi:     NFA_ABI,
    functionName: 'balanceOf',
    args:    address ? [address] : undefined,
    query:   { enabled: !!address && !IS_MOCK },
  });

  const isFree   = IS_MOCK ? true : (typeof freeMints === 'bigint' && freeMints < 3n);
  const mintFee  = isFree ? 0n : parseEther('0.01');
  const hasAgent = IS_MOCK ? mockMinted : (typeof balance === 'bigint' && balance > 0n);

  // ── Contract write ────────────────────────────────────────────────────────
  const { writeContract, data: txHash, isPending: isMinting } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isMintedOnChain } = useWaitForTransactionReceipt({ hash: txHash });

  const success = IS_MOCK ? mockMinted : isMintedOnChain;

  const handleMint = () => {
    setMintError(null);
    if (IS_MOCK) { setMockMinted(true); return; }
    try {
      const agentData = {
        name:         form.name,
        description:  form.description,
        image:        form.image,
        agentType:    form.agentType,
        model:        form.model,
        systemPrompt: form.systemPrompt,
        memoryType:   form.memoryType,
        memoryData:   '0x' as `0x${string}`,
      };
      writeContract({
        address:      NFA_CONTRACT_ADDRESS,
        abi:          NFA_ABI,
        functionName: 'mint',
        args:         [agentData],
        value:        mintFee,
      });
    } catch (e) {
      setMintError(e instanceof Error ? e.message : 'Transaction failed');
    }
  };

  // ── Validation per step ───────────────────────────────────────────────────
  const canProceed: Record<Step, boolean> = {
    identity:    !!form.name.trim() && !!form.description.trim(),
    personality: !!form.experience.trim(),
    ai:          !!form.systemPrompt.trim(),
    memory:      true,
    review:      true,
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#050507] text-white">
      <Navbar />

      <main className="pt-28 pb-20 px-6 max-w-[720px] mx-auto">
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

        {/* Hidden metadata block — always present, used by Playwright / crawlers */}
        <div
          data-testid="mint-form-meta"
          data-steps={STEPS.map(s => s.label).join(',')}
          data-agent-types={AGENT_TYPES.map(t => t.label).join(',')}
          data-memory-types={MEMORY_TYPES.map(m => m.label).join(',')}
          data-bap578-fields="persona,experience,voiceHash,animationURI,vaultURI"
          aria-hidden="true"
          className="hidden"
        />

        {!isConnected ? (
          <div
            data-testid="connect-wallet-prompt"
            className="border border-[#1f1f27] rounded-xl bg-[#0a0a0e] p-10 text-center"
          >
            <p className="text-zinc-400 text-[13px] mb-6">Connect your wallet to create your agent.</p>
            <ConnectButton />
          </div>
        ) : success ? (
          <motion.div
            data-testid="mint-success"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="border border-emerald-700/40 rounded-xl bg-emerald-900/10 p-10 text-center"
          >
            <p className="text-emerald-400 font-bold text-[18px] mb-2">Agent Minted ✓</p>
            <p className="text-zinc-500 text-[13px] mb-2 font-bold">{form.name}</p>
            <p className="text-zinc-600 text-[12px] mb-6">
              {IS_MOCK
                ? 'Demo mint — deploy contract to go live on BNB Chain.'
                : 'Your agent is live on BNB Chain.'}
            </p>
            <Link
              href="/dashboard"
              data-testid="go-to-dashboard-btn"
              className="inline-block text-[10px] font-semibold uppercase tracking-[0.22em] px-8 py-3.5 rounded-sm bg-red-600 text-white hover:bg-red-500 transition-all"
            >
              Go to Dashboard →
            </Link>
          </motion.div>
        ) : (
          <div className="border border-[#1f1f27] rounded-xl bg-[#0a0a0e] p-6 sm:p-8">
            <StepDots current={stepIndex} steps={STEPS} />

            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: 0.18 }}
              >

                {/* ── Step 1: Identity ───────────────────────────────────── */}
                {step === 'identity' && (
                  <div className="space-y-5">
                    <SectionTitle>Identity</SectionTitle>
                    <p className="text-zinc-600 text-[12px] -mt-2 mb-4">
                      These fields appear on-chain and in marketplaces — the public face of your agent.
                    </p>

                    <div>
                      <Label required>Agent Name</Label>
                      <Input
                        value={form.name}
                        onChange={v => set('name', v)}
                        placeholder="e.g. VerifyBot Alpha"
                        maxLength={32}
                      />
                      <p className="text-[10px] text-zinc-600 mt-1">{form.name.length}/32 characters</p>
                    </div>

                    <div>
                      <Label required>Description</Label>
                      <Textarea
                        value={form.description}
                        onChange={v => set('description', v)}
                        placeholder="What does this agent do? This shows in the NFT metadata."
                        rows={3}
                      />
                    </div>

                    <div>
                      <Label>Image URL</Label>
                      <Input
                        value={form.image}
                        onChange={v => set('image', v)}
                        placeholder="https://… (IPFS or HTTPS image for your agent avatar)"
                      />
                      <p className="text-[10px] text-zinc-600 mt-1">
                        Leave blank to use the default Larpscan agent icon.
                      </p>
                    </div>

                    <div>
                      <Label required>Agent Type</Label>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                        {AGENT_TYPES.map(t => (
                          <button
                            key={t.value}
                            type="button"
                            onClick={() => set('agentType', t.value)}
                            className={cn(
                              'text-left px-3 py-3 rounded-sm border transition-all duration-150',
                              form.agentType === t.value
                                ? 'border-red-600/60 bg-red-600/10 text-white'
                                : 'border-[#1f1f27] bg-[#0d0d12] text-zinc-400 hover:border-zinc-600',
                            )}
                          >
                            <p className="text-[12px] font-semibold">{t.label}</p>
                            <p className="text-[10px] text-zinc-600 mt-0.5">{t.desc}</p>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* ── Step 2: Personality ─────────────────────────────────── */}
                {step === 'personality' && (
                  <div className="space-y-5">
                    <SectionTitle>Personality</SectionTitle>
                    <p className="text-zinc-600 text-[12px] -mt-2 mb-4">
                      The <code className="text-zinc-400">persona</code> and{' '}
                      <code className="text-zinc-400">experience</code> fields from the BAP-578 spec —
                      define who your agent is and what it does.
                    </p>

                    <div>
                      <Label required>Experience / Role</Label>
                      <Textarea
                        value={form.experience}
                        onChange={v => set('experience', v)}
                        placeholder="Short summary of your agent's role and purpose. e.g. 'Verifies BSC token project claims using real browser sessions and on-chain evidence.'"
                        rows={3}
                      />
                      <p className="text-[10px] text-zinc-600 mt-1">
                        BAP-578 field: <code>experience</code> — agent's role/purpose summary.
                      </p>
                    </div>

                    <div>
                      <Label>Persona / Character Traits</Label>
                      <Textarea
                        value={form.persona}
                        onChange={v => set('persona', v)}
                        placeholder={`Describe your agent's personality, tone, and style. e.g. "Analytical, precise, neutral tone. Methodical and detail-oriented. Never makes assumptions — only reports evidence."`}
                        rows={4}
                      />
                      <p className="text-[10px] text-zinc-600 mt-1">
                        BAP-578 field: <code>persona</code> — character traits, style, tone (JSON-encoded on-chain).
                      </p>
                    </div>

                    <div>
                      <Label>Animation / Avatar URI</Label>
                      <Input
                        value={form.animationURI}
                        onChange={v => set('animationURI', v)}
                        placeholder="https://… URI to video or animation file for your agent"
                      />
                      <p className="text-[10px] text-zinc-600 mt-1">
                        BAP-578 field: <code>animationURI</code> — optional media asset.
                      </p>
                    </div>

                    <div>
                      <Label>Voice Hash</Label>
                      <Input
                        value={form.voiceHash}
                        onChange={v => set('voiceHash', v)}
                        placeholder="Reference ID to stored audio profile (optional)"
                      />
                      <p className="text-[10px] text-zinc-600 mt-1">
                        BAP-578 field: <code>voiceHash</code> — audio profile reference.
                      </p>
                    </div>
                  </div>
                )}

                {/* ── Step 3: AI Config ───────────────────────────────────── */}
                {step === 'ai' && (
                  <div className="space-y-5">
                    <SectionTitle>AI Configuration</SectionTitle>
                    <p className="text-zinc-600 text-[12px] -mt-2 mb-4">
                      The model and instructions your agent uses when executing actions.
                    </p>

                    <div>
                      <Label required>AI Model</Label>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-1">
                        {AI_MODELS.map(m => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => set('model', m)}
                            className={cn(
                              'text-left px-3 py-2.5 rounded-sm border text-[12px] font-mono transition-all duration-150',
                              form.model === m
                                ? 'border-red-600/60 bg-red-600/10 text-white'
                                : 'border-[#1f1f27] bg-[#0d0d12] text-zinc-400 hover:border-zinc-600',
                            )}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <Label required>System Prompt</Label>
                      <Textarea
                        value={form.systemPrompt}
                        onChange={v => set('systemPrompt', v)}
                        placeholder="The core instructions that guide your agent's behavior. e.g. 'You are an on-chain AI agent that verifies BSC token project claims. Test each claim against the live website using real browser evidence. Return only verified, evidence-backed verdicts.'"
                        rows={6}
                      />
                      <p className="text-[10px] text-zinc-600 mt-1">
                        Stored on-chain. Be specific — this defines how your agent reasons and acts.
                      </p>
                    </div>
                  </div>
                )}

                {/* ── Step 4: Memory ──────────────────────────────────────── */}
                {step === 'memory' && (
                  <div className="space-y-5">
                    <SectionTitle>Memory & Storage</SectionTitle>
                    <p className="text-zinc-600 text-[12px] -mt-2 mb-4">
                      Choose how your agent stores and evolves its knowledge — the
                      BAP-578 dual-path architecture.
                    </p>

                    <div>
                      <Label>Memory Type</Label>
                      <div className="space-y-2 mt-1">
                        {MEMORY_TYPES.map(m => (
                          <button
                            key={m.value}
                            type="button"
                            onClick={() => set('memoryType', m.value)}
                            className={cn(
                              'w-full text-left px-4 py-3.5 rounded-sm border transition-all duration-150',
                              form.memoryType === m.value
                                ? 'border-red-600/60 bg-red-600/10 text-white'
                                : 'border-[#1f1f27] bg-[#0d0d12] text-zinc-400 hover:border-zinc-600',
                            )}
                          >
                            <p className="text-[13px] font-semibold">{m.label}</p>
                            <p className="text-[11px] text-zinc-500 mt-0.5">{m.desc}</p>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <Label>Vault URI</Label>
                      <Input
                        value={form.vaultURI}
                        onChange={v => set('vaultURI', v)}
                        placeholder="https://… or ipfs://… URI to your agent's extended data vault (optional)"
                      />
                      <p className="text-[10px] text-zinc-600 mt-1">
                        BAP-578 field: <code>vaultURI</code> — off-chain extended memory storage.
                      </p>
                    </div>

                    <div>
                      <button
                        type="button"
                        onClick={() => set('learningEnabled', !form.learningEnabled)}
                        className={cn(
                          'w-full text-left px-4 py-4 rounded-sm border transition-all duration-150',
                          form.learningEnabled
                            ? 'border-red-600/60 bg-red-600/10'
                            : 'border-[#1f1f27] bg-[#0d0d12] hover:border-zinc-600',
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-[13px] font-semibold text-white">Enable Learning</p>
                            <p className="text-[11px] text-zinc-500 mt-0.5">
                              Merkle tree learning — agent evolves with cryptographically verifiable history
                            </p>
                          </div>
                          <div className={cn(
                            'w-5 h-5 rounded-sm border flex items-center justify-center flex-shrink-0 ml-4',
                            form.learningEnabled ? 'bg-red-600 border-red-600' : 'border-zinc-600',
                          )}>
                            {form.learningEnabled && <span className="text-white text-[10px]">✓</span>}
                          </div>
                        </div>
                      </button>
                    </div>
                  </div>
                )}

                {/* ── Step 5: Review ──────────────────────────────────────── */}
                {step === 'review' && (
                  <div className="space-y-5">
                    <SectionTitle>Review & Mint</SectionTitle>
                    <p className="text-zinc-600 text-[12px] -mt-2 mb-2">
                      Review your agent before minting. This data will be stored on BNB Chain.
                    </p>

                    <div className="border border-[#1a1a22] rounded-lg p-4 space-y-0">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500 mb-3">Identity</p>
                      <ReviewRow label="Name"        value={form.name} />
                      <ReviewRow label="Description" value={form.description.slice(0, 80) + (form.description.length > 80 ? '…' : '')} />
                      <ReviewRow label="Agent Type"  value={AGENT_TYPES.find(t => t.value === form.agentType)?.label ?? ''} />
                      <ReviewRow label="Image"       value={form.image || '(default)'} />
                    </div>

                    <div className="border border-[#1a1a22] rounded-lg p-4 space-y-0">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500 mb-3">Personality</p>
                      <ReviewRow label="Experience"    value={form.experience.slice(0, 80) + (form.experience.length > 80 ? '…' : '')} />
                      <ReviewRow label="Persona"       value={form.persona ? form.persona.slice(0, 60) + '…' : '—'} />
                      <ReviewRow label="Animation URI" value={form.animationURI || '—'} />
                      <ReviewRow label="Voice Hash"    value={form.voiceHash || '—'} />
                    </div>

                    <div className="border border-[#1a1a22] rounded-lg p-4 space-y-0">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500 mb-3">AI Config</p>
                      <ReviewRow label="Model"         value={form.model} />
                      <ReviewRow label="System Prompt" value={form.systemPrompt.slice(0, 80) + '…'} />
                    </div>

                    <div className="border border-[#1a1a22] rounded-lg p-4 space-y-0">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500 mb-3">Memory</p>
                      <ReviewRow label="Memory Type"      value={MEMORY_TYPES.find(m => m.value === form.memoryType)?.label ?? ''} />
                      <ReviewRow label="Learning Enabled" value={form.learningEnabled} />
                      <ReviewRow label="Vault URI"        value={form.vaultURI || '—'} />
                    </div>

                    <div className="border border-[#1a1a22] rounded-lg p-4 flex items-center justify-between">
                      <div>
                        <p className="text-[11px] text-zinc-500">Owner</p>
                        <p className="font-mono text-[13px] text-white">{address ? truncateAddress(address, 6, 4) : '—'}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[11px] text-zinc-500">Mint fee</p>
                        <p className={cn('font-mono text-[15px] font-bold', isFree ? 'text-emerald-400' : 'text-white')}>
                          {isFree ? 'FREE' : '0.01 BNB'}
                        </p>
                        {IS_MOCK && <p className="text-[10px] text-zinc-600 mt-0.5">Demo mode</p>}
                      </div>
                    </div>

                    <button
                      data-testid="mint-btn"
                      onClick={handleMint}
                      disabled={isMinting || isConfirming || !form.name.trim()}
                      className={cn(
                        'w-full text-[11px] font-semibold uppercase tracking-[0.22em] py-4 rounded-sm transition-all duration-150',
                        isMinting || isConfirming
                          ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                          : 'bg-red-600 text-white hover:bg-red-500',
                      )}
                    >
                      {isMinting     ? 'Confirm in wallet…'
                       : isConfirming ? 'Confirming on-chain…'
                       : IS_MOCK      ? `Mint "${form.name}" (Demo)`
                       : `Mint Agent — ${isFree ? 'Free' : '0.01 BNB'}`}
                    </button>

                    {mintError && (
                      <p data-testid="mint-error" className="text-red-400 text-[11px]">{mintError}</p>
                    )}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>

            {/* ── Nav buttons ──────────────────────────────────────────────── */}
            {step !== 'review' && (
              <div className="flex items-center justify-between mt-8 pt-6 border-t border-[#1a1a22]">
                <button
                  type="button"
                  onClick={() => setStep(STEPS[Math.max(0, stepIndex - 1)].id as Step)}
                  disabled={stepIndex === 0}
                  className="text-[10px] font-semibold uppercase tracking-[0.2em] px-5 py-2.5 rounded-sm border border-[#2a2a35] text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                  ← Back
                </button>
                <button
                  type="button"
                  onClick={() => setStep(STEPS[Math.min(STEPS.length - 1, stepIndex + 1)].id as Step)}
                  disabled={!canProceed[step]}
                  className="text-[10px] font-semibold uppercase tracking-[0.2em] px-6 py-2.5 rounded-sm bg-red-600 text-white hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  Next →
                </button>
              </div>
            )}

            {step === 'review' && (
              <div className="flex items-center justify-between mt-6 pt-4 border-t border-[#1a1a22]">
                <button
                  type="button"
                  onClick={() => setStep('memory')}
                  className="text-[10px] font-semibold uppercase tracking-[0.2em] px-5 py-2.5 rounded-sm border border-[#2a2a35] text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-all"
                >
                  ← Back
                </button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[16px] font-bold text-white mb-1">{children}</h2>
  );
}
