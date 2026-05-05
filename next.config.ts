import type { NextConfig } from 'next';

const config: NextConfig = {
  serverExternalPackages: [
    'playwright',
    'playwright-core',
    'ffmpeg-static',
  ],
  outputFileTracingIncludes: {
    '/api/verify/claim': [
      './node_modules/ffmpeg-static/**/*',
    ],
  },
  webpack(webpackConfig) {
    // Stub out optional native/RN deps pulled in by wagmi connectors & WalletConnect
    webpackConfig.resolve.fallback = {
      ...webpackConfig.resolve.fallback,
      'pino-pretty':                             false,
      'lokijs':                                  false,
      'encoding':                                false,
      '@react-native-async-storage/async-storage': false,
    };
    return webpackConfig;
  },
};

export default config;
