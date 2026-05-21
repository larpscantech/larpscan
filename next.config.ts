import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Frame-Options',           value: 'DENY' },
  { key: 'X-Content-Type-Options',    value: 'nosniff' },
  { key: 'Referrer-Policy',           value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy',          value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https: wss:",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; '),
  },
];

const config: NextConfig = {
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
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
