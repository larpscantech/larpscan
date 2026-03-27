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
};

export default config;
