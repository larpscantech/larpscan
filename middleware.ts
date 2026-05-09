import { NextRequest, NextResponse } from 'next/server';

/**
 * Security middleware
 *
 * 1. Server-to-server routes (/api/verify/claim, /api/verify/run):
 *    Require X-Internal-Key header matching INTERNAL_API_KEY env var.
 *    These routes are only called by the claim dispatcher — never by browsers.
 *
 * 2. All other /api/* routes:
 *    Enforce same-origin by checking Origin / Referer header so they
 *    cannot be invoked from arbitrary third-party domains.
 */

const INTERNAL_ROUTES = ['/api/verify/claim', '/api/verify/run'];

function getAllowedOrigins(): string[] {
  const origins: string[] = ['http://localhost:3000', 'http://localhost:3001'];
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (siteUrl) origins.push(siteUrl.replace(/\/$/, ''));
  return origins;
}

function isSameOrigin(req: NextRequest): boolean {
  const origin   = req.headers.get('origin')   ?? '';
  const referer  = req.headers.get('referer')  ?? '';
  const host     = req.headers.get('host')     ?? '';
  const allowed  = getAllowedOrigins();

  if (origin) {
    return allowed.some(o => origin === o) || origin.includes(host);
  }
  if (referer) {
    return allowed.some(o => referer.startsWith(o)) || referer.includes(host);
  }
  // Server-side fetch (SSR, API-to-API within same process) — no Origin header
  return true;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ── Internal-only routes: require secret key ──────────────────────────────
  if (INTERNAL_ROUTES.some(p => pathname === p || pathname.startsWith(p + '/'))) {
    const internalKey  = process.env.INTERNAL_API_KEY ?? '';
    const providedKey  = req.headers.get('x-internal-key') ?? '';

    if (!internalKey) {
      // Key not configured — fail closed in production, allow in dev
      if (process.env.NODE_ENV === 'production') {
        console.error('[middleware] INTERNAL_API_KEY is not set — blocking request');
        return new NextResponse(JSON.stringify({ error: 'Service unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } else if (providedKey !== internalKey) {
      return new NextResponse(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // ── All other API routes: enforce same-origin for mutating methods ─────────
  if (pathname.startsWith('/api/') && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
    if (!isSameOrigin(req)) {
      return new NextResponse(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*'],
};
