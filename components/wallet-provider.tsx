'use client';

import dynamic from 'next/dynamic';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { wagmiConfig } from '@/lib/wagmi-config';
import { useState } from 'react';
import '@rainbow-me/rainbowkit/styles.css';

function InnerProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor:           '#dc2626',
            accentColorForeground: 'white',
            borderRadius:          'small',
            fontStack:             'system',
            overlayBlur:           'small',
          })}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

/**
 * Loaded with ssr:false so wagmi/WalletConnect never runs localStorage
 * during Next.js server-side rendering (avoids "localStorage is not a function").
 */
const DynamicProvider = dynamic(
  () => Promise.resolve(InnerProvider),
  { ssr: false },
);

export function WalletProviderWrapper({ children }: { children: React.ReactNode }) {
  return <DynamicProvider>{children}</DynamicProvider>;
}
