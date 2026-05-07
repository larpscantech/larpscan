/**
 * BAP-578 NFA contract — ABI sourced directly from deployed proxy on BNB Chain.
 * Proxy: 0x15b15df2ffff6653c21c11b93fb8a7718ce854ce
 *
 * Status enum: 0 = Active, 1 = Paused, 2 = Terminated
 */

export const NFA_CONTRACT_ADDRESS =
  (process.env.NEXT_PUBLIC_NFA_CONTRACT_ADDRESS as `0x${string}` | undefined) ??
  '0x15b15df2ffff6653c21c11b93fb8a7718ce854ce';

export const PLATFORM_LOGIC_ADDRESS =
  (process.env.NEXT_PUBLIC_PLATFORM_LOGIC_ADDRESS as `0x${string}` | undefined) ??
  '0x4155b2DcF0200eE266F73a199a4b10E8CD755841';

export const NFA_ABI = [
  // ── Read ──────────────────────────────────────────────────────────────────
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs:  [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'ownerOf',
    type: 'function',
    stateMutability: 'view',
    inputs:  [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'tokenOfOwnerByIndex',
    type: 'function',
    stateMutability: 'view',
    inputs:  [{ name: 'owner', type: 'address' }, { name: 'index', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'totalSupply',
    type: 'function',
    stateMutability: 'view',
    inputs:  [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'tokenURI',
    type: 'function',
    stateMutability: 'view',
    inputs:  [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    // Returns struct State { balance, status (uint8: 0=Active,1=Paused,2=Terminated), owner, logicAddress, lastActionTimestamp }
    name: 'getState',
    type: 'function',
    stateMutability: 'view',
    inputs:  [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'balance',             type: 'uint256' },
          { name: 'status',              type: 'uint8'   },
          { name: 'owner',               type: 'address' },
          { name: 'logicAddress',        type: 'address' },
          { name: 'lastActionTimestamp', type: 'uint256' },
        ],
      },
    ],
  },
  {
    name: 'getAgentMetadata',
    type: 'function',
    stateMutability: 'view',
    inputs:  [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'persona',      type: 'string'  },
          { name: 'experience',   type: 'string'  },
          { name: 'voiceHash',    type: 'string'  },
          { name: 'animationURI', type: 'string'  },
          { name: 'vaultURI',     type: 'string'  },
          { name: 'vaultHash',    type: 'bytes32' },
        ],
      },
    ],
  },
  // ── Write ─────────────────────────────────────────────────────────────────
  {
    // nonpayable — no mint fee
    name: 'createAgent',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to',           type: 'address' },
      { name: 'logicAddress', type: 'address' },
      { name: 'metadataURI',  type: 'string'  },
      {
        name: 'extendedMetadata',
        type: 'tuple',
        components: [
          { name: 'persona',      type: 'string'  },
          { name: 'experience',   type: 'string'  },
          { name: 'voiceHash',    type: 'string'  },
          { name: 'animationURI', type: 'string'  },
          { name: 'vaultURI',     type: 'string'  },
          { name: 'vaultHash',    type: 'bytes32' },
        ],
      },
    ],
    outputs: [{ name: 'tokenId', type: 'uint256' }],
  },
  {
    name: 'fundAgent',
    type: 'function',
    stateMutability: 'payable',
    inputs:  [{ name: 'tokenId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'withdrawFromAgent',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs:  [{ name: 'tokenId', type: 'uint256' }, { name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'pause',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs:  [{ name: 'tokenId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'unpause',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs:  [{ name: 'tokenId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'setLogicAddress',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs:  [{ name: 'tokenId', type: 'uint256' }, { name: 'newLogicAddress', type: 'address' }],
    outputs: [],
  },
] as const;
