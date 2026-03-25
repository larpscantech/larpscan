import type { VerificationJob, RecentVerification } from './types';

export const MOCK_JOB_ID = 'dc0c6709-2dfe-48a8-b422-e0fa9afe4f98';

export const mockVerificationJob: VerificationJob = {
  id: MOCK_JOB_ID,
  project: {
    name: 'Vortex',
    ticker: 'VRTX',
    logoInitial: 'V',
    website: 'VortexDeployer.com',
    xHandle: '@vortexdeployer',
    contractAddress: 'DS95TEYsRDhYnf7HPpGE2pRBpcxxGMpn94KpBZEJpump',
  },
  status: 'complete',
  claims: [
    {
      id: '01',
      title: 'TOKEN BUNDLER AND LAUNCHER',
      description: 'Platform claims to provide one-click token bundling and permissionless deployment.',
      verdict: 'LARP',
      evidence:
        "The API at /api/launch doesn't exist (404). The API at /api/deploy doesn't exist (404). Login page requires Cloudflare Turnstile CAPTCHA before form can be submitted. Direct API calls to /api/auth/login and /api/auth/register both return HTTP 429 (rate limited). Cannot authenticate to reach /create-project form. Pass condition (token creation form submits + deployed contract address) cannot be verified without an authenticated session.",
    },
    {
      id: '02',
      title: 'MULTI-WALLET SWAP MANAGER',
      description: 'Claims to allow bulk swapping from multiple wallets simultaneously via a dashboard.',
      verdict: 'LARP',
      evidence:
        "The API at /swap doesn't exist (404). The API at /api/swap doesn't exist (404). The page at /docs/swap-manager doesn't exist (404). No swap interface was found anywhere on the live domain.",
    },
    {
      id: '03',
      title: 'AGED WALLET MARKETPLACE',
      description: 'Marketplace for buying and selling aged on-chain wallets with established transaction history.',
      verdict: 'LARP',
      evidence:
        "The API at /aged-wallets doesn't exist (404). The API at /dashboard/aged-wallets doesn't exist (404). The API at /marketplace doesn't exist (404). No marketplace UI was rendered on the live domain.",
    },
  ],
  logs: [
    'Extracting token data',
    'Token data extracted',
    'Checking social sources',
    'Fetching tweets from X',
    'Fetched 225 tweets',
    'Analyzing 225 tweets',
    'Extracting claims...',
    'Analysis complete',
    '3 claims extracted',
    'Queued for verification',
    'Verification in progress',
    'Claim 1/3 — testing...',
    'Claim 2/3 — testing...',
    'Claim 3/3 — testing...',
    'Verification complete',
  ],
  startedAt: '2024-01-15T10:23:00Z',
  completedAt: '2024-01-15T10:24:02Z',
  estTimeSeconds: 58,
};

export const recentVerifications: RecentVerification[] = [
  {
    id: 'v1',
    project: {
      name: 'Vortex',
      ticker: 'VRTX',
      logoInitial: 'V',
      website: 'VortexDeployer.com',
      xHandle: '@vortexdeployer',
      contractAddress: 'DS95TEYsRDhYnf7HPpGE2pRBpcxxGMpn94KpBZEJpump',
    },
    status: 'in_progress',
    claimsTotal: 3,
    claimsVerified: 1,
    estTime: '~58s',
  },
  {
    id: 'v2',
    project: {
      name: 'REVM',
      ticker: 'REVM',
      logoInitial: 'R',
      website: 'revm.io',
      xHandle: '@revm',
      contractAddress: 'EX4nLYnf7HPpGE2pRBpcxxGMpn94KpBZEJpump',
    },
    status: 'complete',
    claimsTotal: 3,
    claimsVerified: 3,
  },
  {
    id: 'v3',
    project: {
      name: 'ApeSwap',
      ticker: 'BANANA',
      logoInitial: 'A',
      website: 'apeswap.finance',
      xHandle: '@ape_swap',
      contractAddress: '7akWM6nf7HPpGE2pRBpcxxGMpn94KpBZEJpump',
    },
    status: 'complete',
    claimsTotal: 3,
    claimsVerified: 2,
  },
  {
    id: 'v4',
    project: {
      name: 'DexVault',
      ticker: 'DVLT',
      logoInitial: 'D',
      website: 'dexvault.io',
      xHandle: '@dexvault',
      contractAddress: '9rXkQPnf7HPpGE2pRBpcxxGMpn94KpBZEJpump',
    },
    status: 'complete',
    claimsTotal: 4,
    claimsVerified: 4,
  },
  {
    id: 'v5',
    project: {
      name: 'PumpVault',
      ticker: 'PVLT',
      logoInitial: 'P',
      website: 'pumpvault.xyz',
      xHandle: '@pumpvault',
      contractAddress: 'BmN3xEnf7HPpGE2pRBpcxxGMpn94KpBZEJpump',
    },
    status: 'complete',
    claimsTotal: 3,
    claimsVerified: 0,
  },
  {
    id: 'v6',
    project: {
      name: 'NexLayer',
      ticker: 'NXL',
      logoInitial: 'N',
      website: 'nexlayer.app',
      xHandle: '@nexlayer',
      contractAddress: 'Cx7mRznf7HPpGE2pRBpcxxGMpn94KpBZEJpump',
    },
    status: 'complete',
    claimsTotal: 5,
    claimsVerified: 3,
  },
];
