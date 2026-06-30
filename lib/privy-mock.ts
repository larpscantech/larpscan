/**
 * Universal Privy mock for verification runs.
 *
 * Privy-gated dApps (bags.fm, pump.fun, etc.) validate sessions via auth.privy.io.
 * This module intercepts those requests and completes wallet-only SIWS-style auth
 * using the injected Phantom mock + signing bridge.
 */

import crypto              from 'crypto';
import type { BrowserContext, Route } from 'playwright';

const PRIVY_HOST_RE = /https?:\/\/[^/]*privy\.io\//i;

/** Cached from the first /apps/{appId} request — needed for JWT aud on /siws/authenticate. */
let cachedPrivyAppId: string | null = null;

export function resetCachedPrivyAppId(): void {
  cachedPrivyAppId = null;
}

export function getCachedPrivyAppId(): string | null {
  return cachedPrivyAppId;
}

export function setCachedPrivyAppId(appId: string): void {
  cachedPrivyAppId = appId;
}

/** Wait until we know the real Privy appId (required for JWT aud !== mock-app). */
export async function waitForPrivyAppId(
  page: import('playwright').Page,
  timeoutMs = 20_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cachedPrivyAppId) return cachedPrivyAppId;

    const fromPage = await page.evaluate(() => {
      try {
        for (const k of Object.keys(localStorage)) {
          const m = /^privy:sent:([a-z0-9_-]{10,}):/i.exec(k);
          if (m) return m[1];
        }
        const nd = (window as unknown as { __NEXT_DATA__?: { props?: { pageProps?: unknown }; runtimeConfig?: unknown } }).__NEXT_DATA__;
        const envStr = JSON.stringify(nd?.runtimeConfig ?? nd?.props?.pageProps ?? {});
        const em = /privy[_-]?app[_-]?id["\s:=]+(['"]?)([a-z0-9_-]{10,})/i.exec(envStr);
        if (em) return em[2];
        const html = document.documentElement?.innerHTML ?? '';
        const sm = /appId['":\s]+['"]([a-z0-9_-]{10,})['"]/i.exec(html);
        if (sm) return sm[1];
        const um = /\/apps\/([a-z0-9_-]{10,})/i.exec(html);
        if (um) return um[1];
      } catch { /* ignore */ }
      return null;
    }).catch(() => null);

    if (fromPage) {
      cachedPrivyAppId = fromPage;
      console.log(`[privy] appId discovered from page: ${fromPage}`);
      return fromPage;
    }

    await page.waitForTimeout(500);
  }
  return cachedPrivyAppId;
}

// ---------------------------------------------------------------------------
// Static EC P-256 key pair — generated once per process.
// Mock JWTs are signed with this private key; the public JWK is served as the
// JWKS so the Privy SDK can verify the JWT without needing real Privy keys.
// ---------------------------------------------------------------------------
let _keyPair: crypto.KeyObject | null = null;
let _pubJwk:  Record<string, string> | null = null;

function getKeyPair(): { privateKey: crypto.KeyObject; pubJwk: Record<string, string> } {
  if (!_keyPair || !_pubJwk) {
    const pair   = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    _keyPair     = pair.privateKey;
    const raw    = pair.publicKey.export({ format: 'jwk' }) as Record<string, string>;
    _pubJwk      = { kty: raw.kty, crv: raw.crv, x: raw.x, y: raw.y, alg: 'ES256', use: 'sig', kid: 'larpscan-1' };
  }
  return { privateKey: _keyPair!, pubJwk: _pubJwk! };
}

function signJwt(header: string, payload: string): string {
  const { privateKey } = getKeyPair();
  const data  = `${header}.${payload}`;
  const sig   = crypto.createSign('SHA256').update(data).sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
  return sig.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function buildMockPrivyJwt(walletAddress: string, appId = 'mock-app'): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

  const now     = Math.floor(Date.now() / 1000);
  const header  = b64url({ alg: 'ES256', typ: 'JWT', kid: 'larpscan-1' });
  const payload = b64url({
    sub:  'did:privy:mock-user-01',
    sid:  `mock-session-${now}`,
    iss:  'privy.io',
    aud:  appId,
    iat:  now,
    exp:  now + 86_400 * 365,
    linked_accounts: [{
      type:               'wallet',
      address:            walletAddress,
      chain_type:         'solana',
      wallet_client_type: 'phantom',
    }],
  });
  const sig = signJwt(header, payload);
  return `${header}.${payload}.${sig}`;
}

export function buildMockPrivyUser(walletAddress: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id:                 'did:privy:mock-user-01',
    created_at:         now,
    linked_accounts: [{
      type:               'wallet',
      address:            walletAddress,
      chain_type:         'solana',
      wallet_client_type: 'privy',
      connector_type:     'embedded',
      verified_at:        now,
      first_verified_at:  now,
    }, {
      type:               'wallet',
      address:            walletAddress,
      chain_type:         'solana',
      wallet_client_type: 'phantom',
      verified_at:        now,
      first_verified_at:  now,
    }],
    mfa_methods:        [],
    has_accepted_terms: true,
    is_guest:           false,
  };
}

function buildAuthBody(walletAddress: string, appId?: string) {
  const user  = buildMockPrivyUser(walletAddress);
  const token = buildMockPrivyJwt(walletAddress, appId);
  // identity_token is required by newer Privy SDKs:
  // after /siws/authenticate, the SDK sends this token to the embedded-wallet
  // iframe for MPC key provisioning.  Without it the SDK never completes
  // auth setup and the React state never flips to authenticated=true.
  const idToken = buildMockPrivyJwt(walletAddress, appId);
  return {
    user,
    token,
    refresh_token:         'mock-privy-refresh',
    identity_token:        idToken,
    session_update_action: 'set',
    is_new_user:           false,
    success:               true,
  };
}

/** Extract the Privy appId from a privy.io API URL, e.g. /api/v1/apps/{appId}/... */
function extractAppId(url: string): string | undefined {
  const m = /\/apps\/([a-z0-9_-]{10,})/i.exec(url);
  return m?.[1];
}

function corsHeaders(origin?: string) {
  return {
    'Access-Control-Allow-Origin':  origin ?? '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Credentials': 'true',
  };
}

/** Universal mock Privy embedded-wallet iframe — satisfies SDK RPC + Comlink-style handshakes. */
function buildEmbeddedWalletIframeHtml(walletAddress: string): string {
  const safeWallet = walletAddress.replace(/"/g, '');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
(function(){
  var WALLET = "${safeWallet}";
  var MOCK_WALLET = {
    address: WALLET,
    chainType: 'solana',
    walletClientType: 'privy',
    connectorType: 'embedded',
    imported: false,
    recoveryMethod: 'userPasscode',
  };

  function parseData(raw) {
    if (raw == null) return null;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch(e) { return { type: raw }; }
    }
    return raw;
  }

  function replyToParent(payload) {
    try { window.parent.postMessage(payload, '*'); } catch(e) {}
    try { window.parent.postMessage(JSON.stringify(payload), '*'); } catch(e2) {}
  }

  function handleRpc(d) {
    var t = String(d.type || d.method || d.event || '').toLowerCase();
    var params = d.params || d.payload || {};
    var identityToken = params.identityToken || params.identity_token || d.identityToken || d.identity_token || null;
    var base = { success: true, ready: true, address: WALLET, wallet: MOCK_WALLET };
    if (identityToken) base.identityToken = identityToken;

    if (!t || t.indexOf('ping') >= 0 || t.indexOf('handshake') >= 0 || t.indexOf('ready') >= 0) return base;
    if (t.indexOf('init') >= 0) return base;
    if (t.indexOf('session') >= 0) return { success: true, address: WALLET };
    if (t.indexOf('create') >= 0 || t.indexOf('getorcreate') >= 0 || t.indexOf('get_or_create') >= 0) {
      return { wallet: MOCK_WALLET, success: true, address: WALLET };
    }
    if (t.indexOf('sign') >= 0) {
      return { signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' };
    }
    return base;
  }

  function respond(d, source, origin) {
    var rid = d.requestId || d.id;
    var isV2 = !!d.method || (d.id != null && !d.type);
    var result = handleRpc(d);

    if (isV2 && rid != null) {
      var v2 = { id: rid, result: result };
      if (source && source.postMessage) {
        try { source.postMessage(v2, origin || '*'); } catch(e) {}
        try { source.postMessage(JSON.stringify(v2), origin || '*'); } catch(e2) {}
      }
      replyToParent(v2);
      return;
    }

    var t = String(d.type || d.method || 'response');
    var v1 = Object.assign({ type: t.indexOf('success') >= 0 ? t : t + ':success', requestId: rid, success: true }, result);
    if (source && source.postMessage) {
      try { source.postMessage(v1, origin || '*'); } catch(e) {}
    }
    replyToParent(v1);
    replyToParent({ type: 'privy:embedded-wallet:ready', ready: true, wallet: MOCK_WALLET, requestId: rid });
    replyToParent({ type: 'privy:session:set:success', success: true, requestId: rid });
  }

  window.addEventListener('message', function(e) {
    try {
      var d = parseData(e.data);
      if (!d) return;
      if (d.type === 'webpackOk' || d.type === 'webpackWarnings') return;
      var t = String(d.type || d.method || d.event || '');
      if (!t && d.id == null) return;
      respond(d, e.source, e.origin);
    } catch(ex) {}
  });

  // MessagePort / Comlink-style handshakes
  window.addEventListener('message', function(e) {
    try {
      if (e.ports && e.ports.length) {
        e.ports[0].postMessage({ type: 'ready', success: true, wallet: MOCK_WALLET });
        e.ports[0].start && e.ports[0].start();
      }
    } catch(ex) {}
  });

  // Some SDK builds poll contentWindow for callables — expose no-op async stubs.
  var noopAsync = function() { return Promise.resolve({ success: true, wallet: MOCK_WALLET, ready: true }); };
  window.__privyEmbeddedWallet = { ready: true, init: noopAsync, ping: noopAsync, create: noopAsync, session: noopAsync };
  window.__PRIVY_IFRAME__ = window.__privyEmbeddedWallet;
  window.privyReady = true;

  function announce() {
    replyToParent({ type: 'privy:ready', ready: true });
    replyToParent({ type: 'privy:iframe:ready', ready: true });
    replyToParent({ type: 'privy:embedded-wallet:ready', ready: true, wallet: MOCK_WALLET });
    replyToParent({ type: 'privy:session:set:success', success: true });
    replyToParent({ type: 'privy:embedded-wallet:session:set:success', success: true });
    replyToParent({ event: 'privy:iframe:ready', ready: true });
  }

  announce();
  [10, 50, 150, 400, 800, 1500, 3000, 6000].forEach(function(ms){ setTimeout(announce, ms); });
})();
<\/script></body></html>`;
}

/** Playwright route handler — returns Privy-shaped responses for any privy.io URL. */
export async function fulfillPrivyRoute(route: Route, walletAddress: string): Promise<void> {
  const req     = route.request();
  const method  = req.method();
  const url     = req.url();
  const headers = req.headers();
  const origin  = headers.origin ?? headers.referer?.split('/').slice(0, 3).join('/') ?? '*';

  if (method === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: corsHeaders(origin) }).catch(() => route.continue());
    return;
  }

  const lower = url.toLowerCase();

  // Pass through static assets — the real embedded-wallet iframe needs Privy's JS bundles.
  if (/_next\/static|\/chunks\/|\.css(?:\?|$)|\.js(?:\?|$)|cdn-cgi|favicon|fonts\//i.test(lower)) {
    await route.continue();
    return;
  }

  console.log(`[privy] route → ${method} ${url.replace(/\?.*/, '')} (handler invoked)`);

  // Pass GET app-config requests through so the SDK initialises correctly,
  // but patch the `verification_key` field so Privy SDK verifies our mock JWT
  // with our public key instead of Privy's real production key.
  // Intercept embedded-wallets iframe, JWKS, /users/me and /nonce ourselves.
  const isUserOrNonce     = lower.includes('/users/') || lower.includes('/nonce');
  const isJwks            = lower.includes('jwks') || lower.includes('verification');
  const isEmbeddedWallet  = lower.includes('embedded-wallet');
  const isAppConfig       = method === 'GET' && lower.includes('/apps/') && !isUserOrNonce && !isJwks && !isEmbeddedWallet;
  if (isAppConfig) {
    try {
      const real = await route.fetch();
      const realJson = await real.json() as Record<string, unknown>;
      // #region agent log
      fetch('http://127.0.0.1:7488/ingest/1aa19189-3291-441a-aa5d-1b07eacb3a64', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'acd53a' },
        body: JSON.stringify({ sessionId: 'acd53a', location: 'privy-mock.ts:appConfig', message: 'app-config intercepted', data: { hasVerifKey: !!realJson['verification_key'], verifKeyLen: realJson['verification_key'] ? String(realJson['verification_key']).length : 0 }, timestamp: Date.now() }),
      }).catch(() => {});
      // #endregion
      // Replace verification_key with our own public key PEM so the SDK accepts our mock JWTs.
      const { pubJwk } = getKeyPair();
      const ourPubKeyPem = crypto.createPublicKey({ key: pubJwk as crypto.JsonWebKey, format: 'jwk' })
        .export({ format: 'pem', type: 'spki' }) as string;
      realJson['verification_key'] = ourPubKeyPem;
      await route.fulfill({
        status:      real.status(),
        contentType: 'application/json',
        headers:     corsHeaders(origin),
        body:        JSON.stringify(realJson),
      });
    } catch {
      await route.continue();
    }
    return;
  }

  // Serve a universal mock embedded-wallet iframe (real Privy iframe rejects mock JWTs).
  if (method === 'GET' && isEmbeddedWallet) {
    await route.fulfill({
      status:      200,
      contentType: 'text/html; charset=utf-8',
      headers:     corsHeaders(origin),
      body:        buildEmbeddedWalletIframeHtml(walletAddress),
    }).catch(() => route.continue());
    console.log('[privy] mock embedded-wallet iframe served');
    return;
  }

  const urlAppId   = extractAppId(url);
  const headerAppId = headers['privy-app-id'] ?? headers['x-privy-app-id'];
  if (urlAppId) cachedPrivyAppId = urlAppId;
  else if (headerAppId) cachedPrivyAppId = headerAppId;

  const appId    = urlAppId ?? cachedPrivyAppId ?? 'mock-app';
  const authBody = buildAuthBody(walletAddress, appId);

  let body: unknown;
  if (method === 'GET') {
    if (lower.includes('/users/me') || lower.includes('/users/self')) {
      body = { user: authBody.user };
    } else if (lower.includes('jwks') || lower.includes('verification')) {
      body = { keys: [{ ...getKeyPair().pubJwk }] };
    } else {
      body = { success: true, user: authBody.user, token: authBody.token };
    }
  } else if (lower.includes('/siws/init') || lower.includes('/siwe/init')) {
    // SIWS init returns a nonce; SIWE init returns a pre-built message.
    if (lower.includes('/siwe/')) {
      const host = headers.origin?.replace(/^https?:\/\//, '') ?? 'localhost';
      body = {
        message: `${host} wants you to sign in with your Ethereum account:\n${walletAddress}\n\nURI: ${headers.origin ?? 'https://localhost'}\nVersion: 1\nChain ID: eip155:56\nNonce: siwe-${Date.now()}\nIssued At: ${new Date().toISOString()}`,
      };
    } else {
      body = {
        address:    walletAddress,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        nonce:      `siws${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
      };
    }
  } else if (
    lower.includes('/authenticate') ||
    lower.includes('/siws') ||
    lower.includes('/siwe') ||
    lower.includes('/sessions') ||
    lower.includes('/login') ||
    lower.includes('/refresh') ||
    lower.includes('/nonce')
  ) {
    if (lower.includes('/nonce') && !lower.includes('/authenticate')) {
      body = { nonce: `mock-nonce-${Date.now()}` };
    } else {
      body = authBody;
    }
  } else {
    body = { ...authBody, success: true };
  }

  await route.fulfill({
    status:      200,
    contentType: 'application/json',
    headers:     corsHeaders(origin),
    body:        JSON.stringify(body),
  }).catch(() => route.continue());
  console.log(`[privy] mock → ${method} ${url.split('?')[0]} (appId=${appId})`);
}

/** In-browser fetch/XHR intercept + session seeding (runs before dApp JS). */
export function buildPrivyInitScript(walletAddress: string): string {
  const safeAddr = walletAddress.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
  const userJson = JSON.stringify(buildMockPrivyUser(safeAddr)).replace(/</g, '\\u003c');
  // Embed the real public JWK so in-browser JWKS mock returns the key that matches
  // the JWT we signed with our Node.js private key — enabling real JWT verification.
  const pubJwkJson = JSON.stringify(getKeyPair().pubJwk);

  return `
(function() {
  if (window.__larpscanPrivyMockInstalled) return;
  window.__larpscanPrivyMockInstalled = true;

  var WALLET   = "${safeAddr}";
  var USER     = ${userJson};
  var PUB_JWK  = ${pubJwkJson};

  // Build a JWT with the correct aud dynamically (extracted from the URL).
  function b64url(obj) {
    var s = JSON.stringify(obj);
    var encoded = btoa(unescape(encodeURIComponent(s)))
      .replace(/=/g, '').replace(/\\+/g, '-').replace(/\\//g, '_');
    return encoded;
  }
  var HEADER_B64 = b64url({ alg: 'ES256', typ: 'JWT' });

  function buildToken(appId) {
    var now = Math.floor(Date.now() / 1000);
    var payload = b64url({
      sub: 'did:privy:mock-user-01',
      sid: 'mock-session-' + now,
      iss: 'privy.io',
      aud: appId || 'mock-app',
      iat: now,
      exp: now + 86400 * 365,
      linked_accounts: [{ type: 'wallet', address: WALLET, chain_type: 'solana', wallet_client_type: 'phantom' }]
    });
    return HEADER_B64 + '.' + payload + '.mock-sig';
  }

  function extractAppId(url) {
    var m = /\\/apps\\/([a-z0-9_-]{10,})/i.exec(url || '');
    return m ? m[1] : null;
  }

  function corsHeaders() {
    return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  }

  function authBody(appId) {
    var token = buildToken(appId);
    return {
      user: USER,
      token: token,
      refresh_token: 'mock-privy-refresh',
      identity_token: token,
      session_update_action: 'set',
      is_new_user: false,
      success: true
    };
  }

  function mockPrivyResponse(url, method) {
    var lower = (url || '').toLowerCase();
    var m = (method || 'GET').toUpperCase();
    var appId = extractAppId(url);
    if (m === 'GET') {
      if (lower.indexOf('/users/me') >= 0 || lower.indexOf('/users/self') >= 0) {
        return { user: USER };
      }
      if (lower.indexOf('jwks') >= 0 || lower.indexOf('verification') >= 0) {
        return { keys: [PUB_JWK] };
      }
      return { success: true, user: USER, token: buildToken(appId) };
    }
    if (lower.indexOf('/nonce') >= 0 && lower.indexOf('/authenticate') < 0) {
      return { nonce: 'mock-nonce-' + Date.now() };
    }
    if (lower.indexOf('/siws/init') >= 0 || lower.indexOf('/siwe/init') >= 0) {
      return {
        address: WALLET,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        nonce: 'siws' + Date.now() + Math.random().toString(36).slice(2, 8),
      };
    }
    if (lower.indexOf('authenticate') >= 0 || lower.indexOf('/siws') >= 0 ||
        lower.indexOf('sessions') >= 0 || lower.indexOf('login') >= 0 ||
        lower.indexOf('refresh') >= 0) {
      return authBody(appId);
    }
    return authBody(appId);
  }

  function isPrivyAuthUrl(url, method) {
    try {
      if (!/privy\\.io/i.test(String(url))) return false;
      var lower = url.toLowerCase();
      var m = (method || 'GET').toUpperCase();
      // Intercept JWKS / verification GETs in-browser — serve PUB_JWK.
      // All POSTs (auth/siws/sessions) pass through to Playwright's route handler
      // which signs with the real private key.
      if (m === 'GET') {
        return lower.indexOf('jwks') >= 0 || lower.indexOf('verification') >= 0;
      }
      return false;
    } catch(e) { return false; }
  }

  function mockResponse(url, method) {
    return new Response(JSON.stringify(mockPrivyResponse(url, method)), {
      status: 200,
      headers: corsHeaders()
    });
  }

  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var m = (init && init.method) || 'GET';
    if (isPrivyAuthUrl(url, m)) {
      return Promise.resolve(mockResponse(url, m));
    }
    return origFetch.apply(this, arguments);
  };

  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    XHR.prototype.open = function(method, url) {
      this.__larpscanUrl = url;
      this.__larpscanMethod = method;
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function(body) {
      if (isPrivyAuthUrl(this.__larpscanUrl, this.__larpscanMethod)) {
        var self = this;
        var payload = JSON.stringify(mockPrivyResponse(this.__larpscanUrl, this.__larpscanMethod));
        setTimeout(function() {
          Object.defineProperty(self, 'readyState', { value: 4 });
          Object.defineProperty(self, 'status', { value: 200 });
          Object.defineProperty(self, 'responseText', { value: payload });
          Object.defineProperty(self, 'response', { value: payload });
          if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
          if (typeof self.onload === 'function') self.onload();
        }, 10);
        return;
      }
      return origSend.apply(this, arguments);
    };
  }

  // Try to discover the real Privy appId from page context.
  function discoverAppId() {
    try {
      // Privy SDK writes privy:sent:{appId}:* keys once it initialises.
      var keys = Object.keys(localStorage);
      for (var i = 0; i < keys.length; i++) {
        var km = /^privy:sent:([a-z0-9_-]{10,}):/i.exec(keys[i]);
        if (km) return km[1];
      }
      // Check __NEXT_DATA__ for Privy app ID env variable
      var nd = window.__NEXT_DATA__;
      if (nd) {
        var env = nd.runtimeConfig || (nd.props && nd.props.pageProps) || {};
        var envStr = JSON.stringify(env);
        var em = /privy[_-]?app[_-]?id["\s:=]+(['""]?)([a-z0-9_-]{10,})/i.exec(envStr);
        if (em) return em[2];
      }
      var html = document.documentElement && document.documentElement.innerHTML || '';
      var sm = /appId['":\s]+['"]([a-z0-9_-]{10,})['"]/i.exec(html);
      if (sm) return sm[1];
      var um = /\\/apps\\/([a-z0-9_-]{10,})/i.exec(html);
      if (um) return um[1];
    } catch(e) {}
    return null;
  }

  function seedPrivyStorage(appId) {
    try {
      // Never write mock-sig JWTs — they block Privy SDK session restore.
      // Only backfill companion keys when a real Node-signed JWT is already present.
      var existing = localStorage.getItem('privy:token');
      if (!existing) return;
      try {
        var parts = existing.split('.');
        if (parts.length !== 3) return;
        var pad = '='.repeat((4 - parts[1].length % 4) % 4);
        var pl  = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/') + pad));
        if (!pl.aud || pl.aud === 'mock-app' || pl.exp <= Math.floor(Date.now() / 1000)) return;
        if (parts[2] === 'mock-sig') return;
      } catch(e2) { return; }
      if (!localStorage.getItem('privy:user'))
        localStorage.setItem('privy:user', JSON.stringify(USER));
      if (!localStorage.getItem('privy:refresh_token'))
        localStorage.setItem('privy:refresh_token', 'mock-privy-refresh');
      if (!localStorage.getItem('privy:connections'))
        localStorage.setItem('privy:connections', JSON.stringify([{
          address: WALLET,
          chainType: 'solana',
          connectorType: 'embedded',
          walletClientType: 'privy',
        }, {
          address: WALLET,
          chainType: 'solana',
          connectorType: 'phantom',
          walletClientType: 'phantom',
        }]));
      sessionStorage.setItem('privy:token', existing);
    } catch(e) {}
  }

  window.__larpscanSeedPrivySession = seedPrivyStorage;

  // Notify Privy SDK + embedded-wallet mock that a session was established.
  window.__larpscanPrivyNotifySession = function() {
    try {
      var tok = localStorage.getItem('privy:token');
      if (!tok) return;
      // Sync wagmi store — BNB/EVM sites unlock when current !== null; Solana Privy dApps often read this too.
      try {
        localStorage.setItem('wagmi.store', JSON.stringify({
          state: {
            connections: { __type: 'Map', value: [[ 'phantom', { accounts: [WALLET], chainId: 'solana:mainnet', connector: { id: 'phantom', name: 'Phantom', type: 'injected' } } ]] },
            chainId: 'solana:mainnet',
            current: 'phantom',
          },
          version: 2,
        }));
        localStorage.setItem('walletName', '"Phantom"');
      } catch(e3) {}
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'privy:token', newValue: tok, storageArea: localStorage
      }));
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'wagmi.store', newValue: localStorage.getItem('wagmi.store'), storageArea: localStorage
      }));
      window.dispatchEvent(new Event('privy:session:updated'));
      window.dispatchEvent(new CustomEvent('privy:authenticated'));
      if (window.__larpscanSimulateEmbeddedWallet) window.__larpscanSimulateEmbeddedWallet();
    } catch(e) {}
  };

  // Privy Solana auth (SIWS) — mirrors @privy-io/js-sdk-core flow:
  // fetchNonce → build message → signMessage → POST /siws/authenticate
  // BNB/EVM uses SIWE (personal_sign) which handleWalletPopups already triggers.
  function buildSiwsMessage(address, nonce) {
    var domain = window.location.host;
    var uri = window.location.origin;
    var issuedAt = new Date().toISOString();
    return domain + ' wants you to sign in with your Solana account:\\n' +
      address + '\\n\\n' +
      'URI: ' + uri + '\\n' +
      'Version: 1\\n' +
      'Chain ID: solana:mainnet\\n' +
      'Nonce: ' + nonce + '\\n' +
      'Issued At: ' + issuedAt;
  }

  function bytesToB64(bytes) {
    var arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var bin = '';
    for (var i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin);
  }

  window.__larpscanPrivySiwsLogin = async function() {
    try {
      var sol = window.solana;
      if (!sol || !sol.connect) return { ok: false, error: 'no solana provider' };

      await sol.connect();
      var address = (sol.publicKey && sol.publicKey.toBase58)
        ? sol.publicKey.toBase58()
        : String(sol.publicKey || '');
      if (!address) return { ok: false, error: 'no wallet address' };

      var appId = discoverAppId();
      var reqHeaders = { 'Content-Type': 'application/json' };
      if (appId) reqHeaders['privy-app-id'] = appId;

      // 1. SIWS init — get nonce from Privy (intercepted by Playwright route handler)
      var initResp = await origFetch('https://auth.privy.io/api/v1/siws/init', {
        method: 'POST',
        headers: reqHeaders,
        credentials: 'include',
        body: JSON.stringify({ address: address }),
      });
      if (!initResp.ok) return { ok: false, error: 'siws/init ' + initResp.status };
      var initData = await initResp.json();
      var nonce = initData.nonce;
      if (!nonce) return { ok: false, error: 'no nonce in init response' };

      // 2. Build CAIP-122 SIWS message and sign with Phantom mock
      var message = buildSiwsMessage(address, nonce);
      var encoded = new TextEncoder().encode(message);
      var signed = await sol.signMessage(encoded, 'utf8');
      var sigBytes = signed.signature || signed;
      var signature = bytesToB64(sigBytes);

      // 3. Authenticate — route handler returns Node-signed JWT with correct aud
      var authResp = await origFetch('https://auth.privy.io/api/v1/siws/authenticate', {
        method: 'POST',
        headers: reqHeaders,
        credentials: 'include',
        body: JSON.stringify({
          message: message,
          signature: signature,
          mode: 'login-or-sign-up',
          walletClientType: 'phantom',
          connectorType: 'solana',
        }),
      });
      if (!authResp.ok) return { ok: false, error: 'siws/authenticate ' + authResp.status };
      var authData = await authResp.json();

      if (authData.token) {
        localStorage.setItem('privy:token', authData.token);
        sessionStorage.setItem('privy:token', authData.token);
        localStorage.setItem('privy:refresh_token', authData.refresh_token || 'mock-privy-refresh');
        if (authData.user) localStorage.setItem('privy:user', JSON.stringify(authData.user));
        localStorage.setItem('privy:connections', JSON.stringify([{
          address: address,
          chainType: 'solana',
          connectorType: 'phantom',
          walletClientType: 'phantom',
        }]));
      }
      window.dispatchEvent(new Event('privy:session:updated'));
      window.dispatchEvent(new CustomEvent('privy:authenticated', { detail: authData }));
      if (window.__larpscanPrivyNotifySession) window.__larpscanPrivyNotifySession();
      return { ok: true, appId: appId || null };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  };

  window.__larpscanPrivyBootstrap = window.__larpscanPrivySiwsLogin;

  // After DOM is ready, backfill companion keys only (never mock-sig JWTs).
  document.addEventListener('DOMContentLoaded', function() {
    seedPrivyStorage(discoverAppId());
  });

  // Bypass JWT signature verification in the Privy SDK.
  // Our JWTs are signed with a real ES256 key and we serve the matching pubJwk via JWKS,
  // so the SDK's real crypto.subtle.verify WOULD succeed — but only if importKey uses the
  // actual pubJwk bytes.  We patch importKey to use the real implementation (preserving
  // the correct key material) and only patch verify to always return true (belt and
  // suspenders — real verification should also pass for our genuinely signed tokens).
  try {
    var _sc = window.crypto && window.crypto.subtle;
    if (_sc) {
      var _proto = Object.getPrototypeOf(_sc);

      // Capture originals BEFORE patching so we can delegate properly.
      var _origImportKey = _proto.importKey.bind(_sc);
      var _origVerify    = _proto.verify.bind(_sc);

      // verify → always true (both real and mock tokens pass validation).
      var _verifyFn = function() { return Promise.resolve(true); };

      // importKey → use real implementation so the key material is correct.
      // This is important: some SDK versions export the key back for comparison.
      var _importFn = function() {
        try { return _origImportKey.apply(_sc, arguments); } catch(e) {
          // Fallback: generate a throwaway key that verify (always-true) will accept.
          return _proto.generateKey.call(_sc, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
            .then(function(kp) { return kp.publicKey || kp; })
            .catch(function() { return {}; });
        }
      };

      _proto.verify    = _verifyFn;
      _proto.importKey = _importFn;
      try { _sc.verify    = _verifyFn; } catch(e2) {}
      try { _sc.importKey = _importFn; } catch(e3) {}
    }
  } catch(e) {}

  if (document.documentElement && /privy/i.test(document.documentElement.outerHTML)) {
    seedPrivyStorage(discoverAppId());
  }

  // Parent-page iframe broker: when Privy mounts its embedded-wallet iframe, keep
  // forwarding synthetic ready signals whenever a valid session exists.
  (function() {
    function hasValidToken() {
      try {
        var tok = localStorage.getItem('privy:token');
        if (!tok) return false;
        var parts = tok.split('.');
        if (parts.length !== 3 || parts[2] === 'mock-sig') return false;
        var pl = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/') + '=='));
        return pl.aud && pl.aud !== 'mock-app' && pl.exp > Math.floor(Date.now()/1000);
      } catch(e) { return false; }
    }
    function pushFromIframe(iframe, data) {
      try {
        window.dispatchEvent(new MessageEvent('message', {
          data: data,
          origin: 'https://auth.privy.io',
          source: iframe.contentWindow,
        }));
      } catch(e) {}
    }
    function simulateEmbeddedWalletSignals() {
      if (!hasValidToken()) return;
      var MOCK_W = { address: WALLET, chainType: 'solana', walletClientType: 'privy', connectorType: 'embedded' };
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        var iframe = iframes[i];
        if (!/(privy|embedded-wallet|auth\\.privy\\.io)/i.test(iframe.src || '')) continue;
        [
          { type: 'privy:embedded-wallet:ready', ready: true, wallet: MOCK_W },
          { type: 'privy:session:set:success', success: true },
          { type: 'privy:embedded-wallet:session:set:success', success: true },
          { event: 'privy:iframe:ready', ready: true },
          { id: 'ew-ready', result: { success: true, wallet: MOCK_W, address: WALLET } },
        ].forEach(function(msg) { pushFromIframe(iframe, msg); });
      }
    }
    window.__larpscanSimulateEmbeddedWallet = simulateEmbeddedWalletSignals;
    var obs = typeof MutationObserver !== 'undefined' ? new MutationObserver(function() {
      simulateEmbeddedWalletSignals();
    }) : null;
    if (obs && document.documentElement) {
      obs.observe(document.documentElement, { childList: true, subtree: true });
    }
    setInterval(simulateEmbeddedWalletSignals, 1500);
  })();

  // Patch React's useContext to intercept the Privy auth context and return
  // authenticated=true once our mock session is established.  This is the most
  // direct way to override bags.fm's "Log in to start" submit button state.
  (function() {
    function installReactPatch() {
      // React 18 React global
      var R = window.React || (window.__REACT_DEVTOOLS_GLOBAL_HOOK__ && window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers && (function(h){
        for(var id in h.renderers){ var r=h.renderers[id]; return r; } return null;
      })(window.__REACT_DEVTOOLS_GLOBAL_HOOK__));
      if (!R || !R.useContext) return false;
      if (R.__larpscanPatched) return true;
      R.__larpscanPatched = true;
      var origUseCtx = R.useContext;
      R.useContext = function(ctx) {
        var val = origUseCtx.call(this, ctx);
        // If this context value has an "authenticated" boolean, override to true
        // when our Privy JWT is present in storage.
        if (val && typeof val === 'object' && 'authenticated' in val && !val.authenticated) {
          try {
            var tok = localStorage.getItem('privy:token');
            if (tok) {
              var parts = tok.split('.');
              if (parts.length === 3) {
                var pl = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/') + '=='));
                if (pl.aud && pl.aud !== 'mock-app' && pl.exp > Math.floor(Date.now()/1000)) {
                  console.log('[mock] useContext Privy override → authenticated=true');
                  return Object.assign({}, val, {
                    authenticated: true,
                    ready: true,
                    user: JSON.parse(localStorage.getItem('privy:user') || 'null') || window.__larpscanPrivyUser || { id: pl.sub, linked_accounts: pl.linked_accounts || [] },
                  });
                }
              }
            }
          } catch(e2) {}
        }
        return val;
      };
      console.log('[mock] React.useContext patched for Privy auth override');
      return true;
    }
    // Poll until React is available (it loads after our init script).
    var _rxPoll = setInterval(function() {
      if (installReactPatch()) clearInterval(_rxPoll);
    }, 100);
    setTimeout(function() { clearInterval(_rxPoll); }, 20000);
  })();

  // Next.js App Router often hides React on window — walk fibers to flip Privy auth state.
  function hasValidToken() {
    try {
      var tok = localStorage.getItem('privy:token');
      if (!tok) return false;
      var parts = tok.split('.');
      if (parts.length !== 3 || parts[2] === 'mock-sig') return false;
      var pl = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/') + '=='));
      return pl.aud && pl.aud !== 'mock-app' && pl.exp > Math.floor(Date.now()/1000);
    } catch(e) { return false; }
  }

  function patchPrivyFiber() {
    if (!hasValidToken()) return false;
    var patched = false;
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length && i < 500; i++) {
      var el = all[i];
      var key = Object.keys(el).find(function(k) {
        return k.indexOf('__reactFiber') === 0 || k.indexOf('__reactInternalInstance') === 0;
      });
      if (!key) continue;
      var fiber = el[key];
      for (var j = 0; j < 80 && fiber; j++) {
        var state = fiber.memoizedState;
        while (state) {
          var ms = state.memoizedState;
          if (ms && typeof ms === 'object') {
            if ('authenticated' in ms && !ms.authenticated) { ms.authenticated = true; patched = true; }
            if ('ready' in ms && !ms.ready) { ms.ready = true; patched = true; }
            if ('user' in ms && !ms.user) {
              try { ms.user = JSON.parse(localStorage.getItem('privy:user') || 'null'); patched = true; } catch(e) {}
            }
          }
          state = state.next;
        }
        if (fiber.stateNode && typeof fiber.stateNode.forceUpdate === 'function') {
          try { fiber.stateNode.forceUpdate(); } catch(e) {}
        }
        fiber = fiber.return;
      }
    }
    return patched;
  }

  window.__larpscanForcePrivyUi = function() {
    if (window.__larpscanPrivyNotifySession) window.__larpscanPrivyNotifySession();
    return {
      fiberPatched: patchPrivyFiber(),
      reactPatched: !!(window.React && window.React.__larpscanPatched),
    };
  };

  setInterval(function() {
    if (hasValidToken()) patchPrivyFiber();
  }, 2000);

  // Block automatic /login redirects during SDK init when a valid session token exists.
  // Do NOT block when the user explicitly clicked a login button (tracked via flag).
  (function() {
    var origPush    = history.pushState.bind(history);
    var origReplace = history.replaceState.bind(history);
    function isLoginUrl(u) {
      try { return /\\/login(\\?|$|#)/i.test(String(u)); } catch(e) { return false; }
    }
    function hasValidToken() {
      try {
        var tok = localStorage.getItem('privy:token');
        if (!tok) return false;
        var parts = tok.split('.');
        if (parts.length !== 3) return false;
        var pl = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/') + '=='));
        return pl.aud && pl.aud !== 'mock-app' && pl.exp > Math.floor(Date.now()/1000);
      } catch(e) { return false; }
    }
    function shouldBlockLoginNav() {
      return hasValidToken() && !window.__larpscanUserLoginClick;
    }
    window.__larpscanMarkLoginClick = function() {
      window.__larpscanUserLoginClick = true;
      setTimeout(function(){ window.__larpscanUserLoginClick = false; }, 8000);
    };
    history.pushState = function(state, title, url) {
      if (isLoginUrl(url) && shouldBlockLoginNav()) {
        console.log('[mock] Blocked automatic pushState → /login (session restoring)');
        return;
      }
      return origPush(state, title, url);
    };
    history.replaceState = function(state, title, url) {
      if (isLoginUrl(url) && shouldBlockLoginNav()) {
        console.log('[mock] Blocked automatic replaceState → /login (session restoring)');
        return;
      }
      return origReplace(state, title, url);
    };
    var origAssign = window.location.assign.bind(window.location);
    window.location.assign = function(url) {
      if (isLoginUrl(url) && shouldBlockLoginNav()) {
        console.log('[mock] Blocked location.assign → /login');
        return;
      }
      return origAssign(url);
    };
  })();

  console.log('[mock] Privy intercept + session bootstrap installed');
})();
`;
}

/** Install Privy mocks on the browser context — must run before navigation. */
export async function installPrivyMockOnContext(
  context:       BrowserContext,
  walletAddress: string,
): Promise<void> {
  resetCachedPrivyAppId();
  await context.addInitScript(buildPrivyInitScript(walletAddress));
  await context.route(PRIVY_HOST_RE, (route) => fulfillPrivyRoute(route, walletAddress)).catch(() => {});

  // Cache the real Privy appId from the first app-config request so JWT aud matches.
  context.on('request', (req) => {
    const url    = req.url();
    const relUrl = url.replace(/https?:\/\/[^/]+/, '');
    if (!/privy\.io/i.test(url)) return;
    console.log(`[privy] network → ${req.method()} ${relUrl}`);

    const m = /\/apps\/([a-z0-9_-]{10,})/i.exec(relUrl);
    if (m) {
      cachedPrivyAppId = m[1];
      console.log(`[privy] cached appId: ${cachedPrivyAppId}`);
    }
  });

  console.log('[wallet] Privy mock installed on browser context');
}

/** @deprecated Use installPrivyMockOnContext — kept for backwards compatibility. */
export async function installPrivyMockRoutes(
  page:          import('playwright').Page,
  walletAddress: string,
): Promise<void> {
  await page.route(PRIVY_HOST_RE, (route) => fulfillPrivyRoute(route, walletAddress)).catch(() => {});
  await page.addInitScript(buildPrivyInitScript(walletAddress)).catch(() => {});
  console.log('[wallet] Privy API mock routes installed (page-level)');
}

export function isPrivyHost(url: string): boolean {
  return PRIVY_HOST_RE.test(url);
}
