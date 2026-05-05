'use client';

import { http } from 'wagmi';
import { bsc, bscTestnet } from 'wagmi/chains';
import { getDefaultConfig } from '@rainbow-me/rainbowkit';

const isDev = process.env.NODE_ENV !== 'production';

export const wagmiConfig = getDefaultConfig({
  appName: 'Larpscan',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? 'demo-larpscan',
  chains: isDev ? [bsc, bscTestnet] : [bsc],
  transports: {
    [bsc.id]:        http('https://bsc-dataseed.binance.org/'),
    [bscTestnet.id]: http('https://data-seed-prebsc-1-s1.binance.org:8545/'),
  },
  ssr: true,
});
