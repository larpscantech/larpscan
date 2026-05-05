/**
 * Minimal ABI for the BAP-578 NFA contract.
 * Full reference: github.com/ChatAndBuild/non-fungible-agents-BAP-578
 *
 * For testnet / local dev we use a mock address.
 * Set NEXT_PUBLIC_NFA_CONTRACT_ADDRESS in .env.local for mainnet.
 */

export const NFA_CONTRACT_ADDRESS =
  (process.env.NEXT_PUBLIC_NFA_CONTRACT_ADDRESS as `0x${string}` | undefined) ??
  '0x0000000000000000000000000000000000000000';

export const NFA_ABI = [
  // ── Read ──────────────────────────────────────────────────────────────────
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'tokenOfOwnerByIndex',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'mintPrice',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'freeMintCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // ── Write ─────────────────────────────────────────────────────────────────
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'agentData',
        type: 'tuple',
        components: [
          { name: 'name',        type: 'string' },
          { name: 'description', type: 'string' },
          { name: 'image',       type: 'string' },
          { name: 'agentType',   type: 'uint8'  },
          { name: 'model',       type: 'string' },
          { name: 'systemPrompt',type: 'string' },
          { name: 'memoryType',  type: 'uint8'  },
          { name: 'memoryData',  type: 'bytes'  },
        ],
      },
    ],
    outputs: [{ name: 'tokenId', type: 'uint256' }],
  },
] as const;

/** Default agent metadata for a Larpscan verifier NFA */
export const DEFAULT_AGENT_DATA = {
  name:         'Larpscan Verifier',
  description:  'AI agent that verifies BSC token claims using real browser sessions. Built on BAP-578.',
  image:        'https://larpscan.sh/icon.png',
  agentType:    1,   // 1 = verifier
  model:        'gpt-4o',
  systemPrompt: 'You are an on-chain AI agent that verifies BSC token project claims. Your verdicts are tamper-proof and signed under your wallet.',
  memoryType:   0,   // 0 = JSON Light Memory
  memoryData:   '0x' as `0x${string}`,
} as const;
