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

// ── Platform personalities ──────────────────────────────────────────────────
const PLATFORM_PERSONALITIES = [
  {
    id:    'verifier',
    label: 'Token Verifier',
    desc:  'Audits BSC token claims using real browser sessions. Neutral, evidence-first.',
    prompt: 'You are an on-chain AI agent that verifies BSC token project claims. Navigate to the live project website, test each claim against real browser evidence, and return only verified, tamper-proof verdicts. Be methodical, neutral, and precise — never assume.',
  },
  {
    id:    'analyst',
    label: 'Market Analyst',
    desc:  'Researches token fundamentals, wallet behaviour, and on-chain signals.',
    prompt: 'You are an on-chain AI agent that analyses BSC token fundamentals. Research contract deployers, wallet history, liquidity patterns, and on-chain signals. Return clear risk assessments backed by evidence.',
  },
  {
    id:    'watchdog',
    label: 'Watchdog',
    desc:  'Monitors a project 24/7 — flags changes in liquidity, dev wallets, or claims.',
    prompt: 'You are an on-chain AI watchdog agent. Monitor the assigned BSC token project continuously. Flag any changes in liquidity, developer wallet movements, or claim accuracy. Alert the owner immediately when risk increases.',
  },
  {
    id:    'custom',
    label: 'Custom',
    desc:  'Write your own system prompt from scratch.',
    prompt: '',
  },
] as const;

type PersonalityId = typeof PLATFORM_PERSONALITIES[number]['id'];

// ── Steps ───────────────────────────────────────────────────────────────────
const STEPS = [
  { id: 'identity',    label: 'Identity' },
  { id: 'personality', label: 'Personality' },
  { id: 'review',      label: 'Review & Mint' },
] as const;

type Step = typeof STEPS[number]['id'];

// ── Form state ──────────────────────────────────────────────────────────────
interface AgentForm {
  name:           string;
  description:    string;
  image:          string;
  personalityId:  PersonalityId;
  systemPrompt:   string;
  persona:        string;  // character traits / tone (BAP-578 field)
  experience:     string;  // role / purpose summary (BAP-578 field)
}

const DEFAULT_FORM: AgentForm = {
  name:          '',
  description:   '',
  image:         '',
  personalityId: 'verifier',
  systemPrompt:  PLATFORM_PERSONALITIES[0].prompt,
  persona:       '',
  experience:    '',
};

// ── Sub-components ───────────────────────────────────────────────────────────
function StepBar({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-0 mb-8 w-full">
      {STEPS.map((s, i) => (
        <div key={s.id} className="flex items-center flex-1 last:flex-none">
          <div className="flex items-center gap-2 shrink-0">
            <div className={cn(
              'flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold transition-all duration-200 shrink-0',
              i < current  ? 'bg-red-600 text-white'
              : i === current ? 'bg-red-600/20 border border-red-600 text-red-400'
              : 'bg-[#16161d] border border-[#2a2a35] text-zinc-600',
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
            <div className={cn(
              'h-px flex-1 mx-3',
              i < current ? 'bg-red-600/40' : 'bg-[#2a2a35]',
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

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 border-b border-[#16161d] last:border-0 text-[12px]">
      <span className="text-zinc-500 flex-shrink-0 w-28">{label}</span>
      <span className="text-zinc-200 text-right font-mono break-all">{value || '—'}</span>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function MintAgentPage() {
  const { address, isConnected } = useAccount();
  const [step, setStep]           = useState<Step>('identity');
  const [form, setForm]           = useState<AgentForm>(DEFAULT_FORM);
  const [mintError, setMintError] = useState<string | null>(null);
  const [mockMinted, setMockMinted] = useState(false);

  const stepIndex = STEPS.findIndex(s => s.id === step);
  const set = <K extends keyof AgentForm>(key: K, value: AgentForm[K]) =>
    setForm(f => ({ ...f, [key]: value }));

  // ── Contract reads ────────────────────────────────────────────────────────
  const { data: freeMints } = useReadContract({
    address: NFA_CONTRACT_ADDRESS, abi: NFA_ABI, functionName: 'freeMintCount',
    args:    address ? [address] : undefined,
    query:   { enabled: !!address && !IS_MOCK },
  });
  const { data: balance } = useReadContract({
    address: NFA_CONTRACT_ADDRESS, abi: NFA_ABI, functionName: 'balanceOf',
    args:    address ? [address] : undefined,
    query:   { enabled: !!address && !IS_MOCK },
  });

  const isFree   = IS_MOCK ? true : (typeof freeMints === 'bigint' && freeMints < 3n);
  const mintFee  = isFree ? 0n : parseEther('0.01');

  // ── Contract write ────────────────────────────────────────────────────────
  const { writeContract, data: txHash, isPending: isMinting } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isMintedOnChain } = useWaitForTransactionReceipt({ hash: txHash });
  const success = IS_MOCK ? mockMinted : isMintedOnChain;

  const handleMint = () => {
    setMintError(null);
    if (IS_MOCK) { setMockMinted(true); return; }
    try {
      writeContract({
        address: NFA_CONTRACT_ADDRESS, abi: NFA_ABI, functionName: 'mint',
        args: [{
          name:         form.name,
          description:  form.description,
          image:        form.image || 'https://larpscan.sh/icon.png',
          agentType:    1,             // Verifier Agent
          model:        'gpt-4o',      // fixed model
          systemPrompt: form.systemPrompt,
          memoryType:   1,             // always Merkle Tree Learning
          memoryData:   '0x' as `0x${string}`,
        }],
        value: mintFee,
      });
    } catch (e) {
      setMintError(e instanceof Error ? e.message : 'Transaction failed');
    }
  };

  const canProceed: Record<Step, boolean> = {
    identity:    !!form.name.trim() && !!form.description.trim(),
    personality: !!form.systemPrompt.trim(),
    review:      true,
  };

  return (
    <div className="min-h-screen bg-[#050507] text-white">
      <Navbar />

      {/* Hidden meta for Playwright / crawlers */}
      <div
        data-testid="mint-form-meta"
        data-steps={STEPS.map(s => s.label).join(',')}
        data-personalities={PLATFORM_PERSONALITIES.map(p => p.id).join(',')}
        data-bap578-fields="persona,experience,systemPrompt,memoryType,agentType"
        aria-hidden="true"
        className="hidden"
      />

      <main className="pt-28 pb-20 px-6 max-w-[680px] mx-auto">
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
            <p className="text-zinc-300 text-[14px] font-semibold mb-1">{form.name}</p>
            <p className="text-zinc-600 text-[12px] mb-6">
              {IS_MOCK ? 'Demo mint — deploy contract to go live on BNB Chain.' : 'Your agent is live on BNB Chain.'}
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
            <StepBar current={stepIndex} />

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
                    <h2 className="text-[16px] font-bold text-white">Identity</h2>
                    <p className="text-zinc-600 text-[12px]">
                      The public face of your agent — appears on-chain and in marketplaces.
                    </p>

                    <div>
                      <Label required>Agent Name</Label>
                      <TextInput
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
                      <TextInput
                        value={form.image}
                        onChange={v => set('image', v)}
                        placeholder="https://… or ipfs://… (leave blank for default)"
                      />
                    </div>
                  </div>
                )}

                {/* ── Step 2: Personality ─────────────────────────────────── */}
                {step === 'personality' && (
                  <div className="space-y-5">
                    <h2 className="text-[16px] font-bold text-white">Personality</h2>
                    <p className="text-zinc-600 text-[12px]">
                      Choose a Larpscan preset or write your own system prompt.
                    </p>

                    <div className="space-y-2">
                      {PLATFORM_PERSONALITIES.map(p => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            set('personalityId', p.id as PersonalityId);
                            if (p.id !== 'custom') set('systemPrompt', p.prompt);
                          }}
                          className={cn(
                            'w-full text-left px-4 py-3.5 rounded-sm border transition-all duration-150',
                            form.personalityId === p.id
                              ? 'border-red-600/60 bg-red-600/10'
                              : 'border-[#1f1f27] bg-[#0d0d12] hover:border-zinc-600',
                          )}
                        >
                          <p className={cn('text-[13px] font-semibold', form.personalityId === p.id ? 'text-white' : 'text-zinc-300')}>
                            {p.label}
                          </p>
                          <p className="text-[11px] text-zinc-500 mt-0.5">{p.desc}</p>
                        </button>
                      ))}
                    </div>

                    <div>
                      <Label required>System Prompt</Label>
                      <Textarea
                        value={form.systemPrompt}
                        onChange={v => {
                          set('systemPrompt', v);
                          set('personalityId', 'custom');
                        }}
                        placeholder="The core instructions guiding your agent's behaviour…"
                        rows={5}
                      />
                      <p className="text-[10px] text-zinc-600 mt-1">
                        Stored on-chain. Selecting a preset above fills this automatically.
                      </p>
                    </div>
                  </div>
                )}

                {/* ── Step 3: Review & Mint ───────────────────────────────── */}
                {step === 'review' && (
                  <div className="space-y-5">
                    <h2 className="text-[16px] font-bold text-white">Review & Mint</h2>
                    <p className="text-zinc-600 text-[12px]">
                      Review before minting — this data is stored permanently on BNB Chain.
                    </p>

                    <div className="border border-[#1a1a22] rounded-lg p-4">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500 mb-1">Identity</p>
                      <ReviewRow label="Name"        value={form.name} />
                      <ReviewRow label="Description" value={form.description.slice(0, 90) + (form.description.length > 90 ? '…' : '')} />
                      <ReviewRow label="Image"       value={form.image || 'default'} />
                    </div>

                    <div className="border border-[#1a1a22] rounded-lg p-4">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500 mb-1">Personality</p>
                      <ReviewRow label="Preset"      value={PLATFORM_PERSONALITIES.find(p => p.id === form.personalityId)?.label ?? 'Custom'} />
                      <ReviewRow label="Prompt"      value={form.systemPrompt.slice(0, 90) + '…'} />
                    </div>

                    <div className="border border-[#1a1a22] rounded-lg p-4">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500 mb-1">On-chain config</p>
                      <ReviewRow label="Standard"   value="BAP-578 NFA" />
                      <ReviewRow label="Memory"     value="Merkle Tree Learning" />
                      <ReviewRow label="Chain"      value="BNB Chain" />
                      <ReviewRow label="Owner"      value={address ? truncateAddress(address, 6, 4) : '—'} />
                    </div>

                    <div className="border border-[#1a1a22] rounded-lg px-4 py-3 flex items-center justify-between">
                      <span className="text-[12px] text-zinc-500">Mint fee</span>
                      <span className={cn('font-mono text-[15px] font-bold', isFree ? 'text-emerald-400' : 'text-white')}>
                        {isFree ? 'FREE' : '0.01 BNB'}
                        {IS_MOCK && <span className="text-[10px] text-zinc-600 ml-2 font-normal">(demo)</span>}
                      </span>
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
                       : IS_MOCK      ? `Mint "${form.name || 'Agent'}" (Demo)`
                       : `Mint Agent — ${isFree ? 'Free' : '0.01 BNB'}`}
                    </button>

                    {mintError && (
                      <p data-testid="mint-error" className="text-red-400 text-[11px]">{mintError}</p>
                    )}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>

            {/* ── Navigation ──────────────────────────────────────────────── */}
            <div className="flex items-center justify-between mt-8 pt-6 border-t border-[#1a1a22]">
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
                  disabled={!canProceed[step]}
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
