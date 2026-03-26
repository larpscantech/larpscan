import type { NextConfig } from 'next';

const config: NextConfig = {
  // These packages contain native binaries or resolve binary paths at require()
  // time.  Bundling them via webpack breaks the path resolution on Vercel
  // (e.g. ffmpeg-static returns a webpack chunk path instead of the real binary).
  // Marking them external keeps real require() calls so the paths stay valid.
  serverExternalPackages: [
    'ffmpeg-static',
    '@sparticuz/chromium',
    'playwright',
    'playwright-core',
  ],

  // Vercel's file-system tracer only follows JS require() chains — it never
  // sees the native binary that ffmpeg-static exports as a path string.
  // outputFileTracingIncludes forces the binary into the Lambda bundle for
  // the one route that needs it.
  outputFileTracingIncludes: {
    '/api/verify/run': [
      './node_modules/ffmpeg-static/**/*',
      './node_modules/@sparticuz/chromium/**/*',
    ],
  },
};

export default config;
