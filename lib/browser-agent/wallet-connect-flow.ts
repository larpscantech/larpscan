import type { Page, BrowserContext } from 'playwright';
import type { WalletPolicy } from '../wallet/policy';
import { evaluatePolicy } from '../wallet/policy';
import { classifyWalletRequest } from '../wallet/request-classifier';
import type { WalletRequestContext, InterceptedWalletPopup } from '../wallet/request-classifier';
import { triggerWalletReconnect } from './wallet-reconnect';

// ─────────────────────────────────────────────────────────────────────────────
// Wallet popup interceptor
//
// Detects wallet connection / transaction prompts on the page, classifies them,
// evaluates them against the provided policy, and either injects wallet address
// data or rejects the request.
//
// This does NOT use a real injected wallet provider. It works by:
//   1. Detecting UI elements that indicate a wallet prompt (connect buttons,
// Detects wallet connect modals and routes to Phantom on Solana dApps.
//      the site proceeds with a read-only address.
//   3. Recording the classified request for evidence.
// ─────────────────────────────────────────────────────────────────────────────

export interface WalletInterceptResult {
  detectedRequests: WalletRequestContext[];
  walletConnected:  boolean;
  rejectedRequests: WalletRequestContext[];
  log:              string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Wallet stack detection — identifies which wallet/auth library a dApp uses
// so the connection flow can be routed to the right strategy.
// ─────────────────────────────────────────────────────────────────────────────

export type WalletStack =
  | 'phantom'
  | 'wallet-adapter'
  | 'privy'
  | 'rainbowkit'
  | 'wagmi-appkit'
  | 'connectkit'
  | 'dynamic'
  | 'thirdweb'
  | 'walletconnect'
  | 'unknown';

export async function detectWalletStack(page: Page): Promise<{ stack: WalletStack; signals: string[] }> {
  return page.evaluate(() => {
    const signals: string[] = [];
    const html = document.documentElement.outerHTML;
    const text = document.body?.innerText?.toLowerCase() ?? '';

    // Phantom / Solana wallet-adapter — check first on Solana dApps
    if ((window as any).solana?.isPhantom || (window as any).phantom?.solana) {
      signals.push('phantom-injected');
      return { stack: 'phantom' as const, signals };
    }
    if (/wallet-adapter|@solana\/wallet-adapter/i.test(html)) {
      signals.push('wallet-adapter-html');
      return { stack: 'wallet-adapter' as const, signals };
    }

    // Privy — still used on some multi-chain dApps
    if (document.querySelector('[data-privy-dialog]') || (window as any).__PRIVY_CONFIG__) {
      signals.push('privy-dialog');
      return { stack: 'privy' as const, signals };
    }
    try {
      if (localStorage.getItem('privy:token') || localStorage.getItem('privy:session')) {
        signals.push('privy-localstorage');
        return { stack: 'privy' as const, signals };
      }
    } catch {}
    if (/privy/i.test(html) && /log in or sign up|continue with a wallet/i.test(text)) {
      signals.push('privy-text');
      return { stack: 'privy' as const, signals };
    }

    // RainbowKit — [data-rk] attribute on modal
    if (document.querySelector('[data-rk]')) {
      signals.push('rainbowkit-data-rk');
      return { stack: 'rainbowkit' as const, signals };
    }
    if (html.includes('rainbowkit') || html.includes('RainbowKit')) {
      signals.push('rainbowkit-html');
      return { stack: 'rainbowkit' as const, signals };
    }

    // ConnectKit — [class*="ck-modal"] or ck- prefixed elements
    if (document.querySelector('[class*="ck-modal"], [class*="ck-"]')) {
      signals.push('connectkit-class');
      return { stack: 'connectkit' as const, signals };
    }

    // Dynamic.xyz — [class*="dynamic-modal"] or dynamic SDK
    if (document.querySelector('[class*="dynamic-modal"], [class*="dynamic-"]')) {
      signals.push('dynamic-class');
      return { stack: 'dynamic' as const, signals };
    }

    // Thirdweb — [class*="thirdweb"], tw-connect
    if (document.querySelector('[class*="thirdweb"], [class*="tw-connect"]')) {
      signals.push('thirdweb-class');
      return { stack: 'thirdweb' as const, signals };
    }

    // Web3Modal / AppKit / Reown — w3m- elements or @appkit localStorage
    if (document.querySelector('w3m-modal, w3m-button, w3m-connect-button, [class*="w3m-"]')) {
      signals.push('w3m-element');
      return { stack: 'wagmi-appkit' as const, signals };
    }
    try {
      if (localStorage.getItem('@appkit/connection_status') !== null) {
        signals.push('appkit-localstorage');
        return { stack: 'wagmi-appkit' as const, signals };
      }
    } catch {}

    // Standalone WalletConnect modal
    if (document.querySelector('[class*="walletconnect"], [class*="WalletConnect"]')) {
      signals.push('walletconnect-class');
      return { stack: 'walletconnect' as const, signals };
    }

    // Wagmi without a specific UI kit — check localStorage
    try {
      if (localStorage.getItem('wagmi.store') !== null) {
        signals.push('wagmi-localstorage');
        return { stack: 'wagmi-appkit' as const, signals };
      }
    } catch {}

    signals.push('no-match');
    return { stack: 'unknown' as const, signals };
  }).catch(() => ({ stack: 'unknown' as WalletStack, signals: ['detection-error'] }));
}

/**
 * Scans the page for visible wallet prompts and handles them according to
 * the provided policy and wallet address. Safe to call at any point during
 * a verification run.
 */
export async function handleWalletPopups(
  page:                Page,
  walletAddress:       string | null,
  policy:              WalletPolicy,
  claimFeatureType:    string = '',
  workflowStage:       string = '',
  spentSolThisRun:   number = 0,
): Promise<WalletInterceptResult> {
  const detectedRequests: WalletRequestContext[] = [];
  const rejectedRequests: WalletRequestContext[] = [];
  const log: string[] = [];
  let walletConnected = false;

  if (!walletAddress) {
    log.push('[wallet] No investigation wallet configured — skipping wallet popup handling');
    return { detectedRequests, walletConnected, rejectedRequests, log };
  }

  // ── Check if wallet is already connected (pre-populated storage / SPA state)
  const shortAddr    = walletAddress.slice(0, 6).toLowerCase();
  const shortAddrEnd = walletAddress.slice(-4).toLowerCase();

  const preConnected = await page.evaluate(
    ({ short, end }: { short: string; end: string }) => {
      const text = document.body?.innerText?.toLowerCase() ?? '';
      // Only consider pre-connected if the actual wallet address is visible in DOM.
      // Previously, "no connect button + page has content" was treated as connected,
      // but many dApps simply don't show a connect button on certain pages (e.g.
      // landing pages, docs) — that doesn't mean a wallet is connected.
      const addrVisible = text.includes(short) && text.includes(end);
      if (addrVisible) return 'address_visible';

      // Secondary signal: truncated address format (0x1b2...3f4a) in DOM
      const truncatedPattern = new RegExp(short + '[.…]{2,}' + end);
      if (truncatedPattern.test(text)) return 'truncated_address';

      // Check for connected-state UI signals (avatar + no connect button)
      const connectBtns = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter((el) => {
          const t = ((el as HTMLElement).innerText ?? '').toLowerCase().trim();
          const s = window.getComputedStyle(el as Element);
          return s.display !== 'none' && s.visibility !== 'hidden' &&
            /^connect wallet$|^connect$|^connect your wallet$/i.test(t);
        });
      const hasProfileIndicator = !!document.querySelector(
        '[class*="avatar" i], [class*="profile" i], [data-testid*="account"], ' +
        '[class*="account-info" i], [class*="user-menu" i], [class*="wallet-info" i]'
      );
      if (connectBtns.length === 0 && hasProfileIndicator) return 'profile_indicator';

      return null;
    },
    { short: shortAddr, end: shortAddrEnd },
  ).catch(() => null);

  if (preConnected) {
    walletConnected = true;
    log.push(`[wallet] Wallet already connected — signal: ${preConnected}`);
    return { detectedRequests, walletConnected, rejectedRequests, log };
  }

  // ── Detect wallet connection prompts ─────────────────────────────────────
  const connectPromptVisible = await page.evaluate(() => {
    const walletKeywords = [
      'connect wallet', 'connect your wallet', 'connect metamask',
      'walletconnect', 'wallet connect', 'connect web3',
      'connect a wallet', 'link wallet', 'attach wallet',
      '連接錢包', '連結錢包', '請連接錢包',
    ];
    const allText = document.body?.innerText?.toLowerCase() ?? '';
    const hasKeyword = walletKeywords.some((kw) => allText.includes(kw));

    // Check for visible connect buttons (broader selector set)
    const connectBtns = Array.from(document.querySelectorAll(
      'button, [role="button"], a[href*="connect"], [data-testid*="connect"]'
    ))
      .filter((el) => {
        const t = ((el as HTMLElement).innerText ?? el.textContent ?? '').toLowerCase().trim();
        const s = window.getComputedStyle(el as Element);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        // Match "Connect Wallet", "Connect", but not "Connected" or "Disconnect"
        return /^connect\b|connect wallet|connect your wallet|連接錢包|連結錢包/i.test(t) &&
          !/disconnect|connected|已連接/i.test(t);
      });

    // Check for wallet modal containers (Web3Modal, RainbowKit, ConnectKit, etc.)
    const walletModal = document.querySelector(
      '[class*="w3m-modal"], [data-rk], [class*="ck-modal"], ' +
      '[class*="WalletModal"], [class*="walletModal"], [class*="wallet-modal"], ' +
      '[data-privy-dialog], [class*="dynamic-modal"], [class*="thirdweb-modal"]'
    );

    return hasKeyword || connectBtns.length > 0 || !!walletModal;
  }).catch(() => false);

  if (connectPromptVisible) {
    const popup: InterceptedWalletPopup = {
      popupType:    'connect',
      visibleText:  'Wallet connection prompt detected',
      originUrl:    page.url(),
    };

    const ctx = classifyWalletRequest(popup, claimFeatureType, workflowStage);
    detectedRequests.push(ctx);

    const decision = evaluatePolicy(policy, {
      actionType: 'connect',
      totalSpentThisRunSol: spentSolThisRun,
    });

    log.push(`[wallet] Connect prompt detected → policy: ${decision.allowed ? 'ALLOW' : 'REJECT'} (${decision.reason})`);

    if (decision.allowed) {
      // Detect which wallet/auth stack the dApp uses
      const { stack: walletStack, signals: stackSignals } = await detectWalletStack(page);
      log.push(`[wallet] Detected stack: ${walletStack} (signals: ${stackSignals.join(', ')})`);

      // ── WALLET CONNECTION FLOW (Phantom / Solana wallet-adapter) ────────
      //
      // Step 1 — Click the site's "Connect Wallet" navbar / page button.
      //          Uses broad regex so "Connect Wallet to Mint", "Connect →", etc.
      //          all match. Tries multiple selectors as fallback.
      // Step 2 — If a Privy social-login modal appears (Twitter/GitHub/etc.),
      //          click "Continue with a wallet" to reach the wallet picker.
      // Step 3 — In the wallet picker, click Phantom.
      //          personal_sign fires → signing bridge → session established.
      // Step 4 — Re-announce EIP-6963 and retry once if first attempt fails.
      // ─────────────────────────────────────────────────────────────────────

      // Helper: find and click any "Connect Wallet" trigger on the page.
      // Deliberately broad — matches partial text like "Connect Wallet to Mint".
      async function clickPrimaryConnectBtn(): Promise<boolean> {
        const btnSelector = 'button, [role="button"], a, div[class*="btn"], span[class*="btn"]';
        const candidates = [
          // Exact common labels
          page.locator(btnSelector).filter({ hasText: /^connect wallet$/i }).first(),
          page.locator(btnSelector).filter({ hasText: /^connect$/i }).first(),
          // Partial — covers "Connect Wallet to Mint", "Connect Wallet →", etc.
          page.locator(btnSelector).filter({ hasText: /connect wallet/i }).first(),
          page.locator(btnSelector).filter({ hasText: /connect your wallet/i }).first(),
          // Chinese variants
          page.locator(btnSelector).filter({ hasText: /連接錢包|連結錢包/ }).first(),
          // Web3Modal / w3m trigger button
          page.locator('w3m-button, w3m-connect-button, [class*="w3m-"] button').first(),
          // data-testid patterns
          page.locator('[data-testid*="connect" i] button, [data-testid*="wallet" i] button').first(),
          // Last resort: any prominent "connect" button in nav/header
          page.locator('nav button, header button, [role="banner"] button, main button').filter({ hasText: /connect/i }).first(),
        ];

        for (const btn of candidates) {
          const vis = await btn.isVisible({ timeout: 1_500 }).catch(() => false);
          if (vis) {
            const txt = (await btn.textContent().catch(() => '') ?? '').trim().slice(0, 60);
            await btn.click().catch(() => {});
            log.push(`[wallet] Clicked connect button: "${txt}"`);
            return true;
          }
        }
        return false;
      }

      // ── Pre-step: direct eth_requestAccounts trigger ─────────────────────
      await triggerWalletReconnect(page, { waitMs: 2_000 });

      // ── Step 1: trigger the wallet modal ────────────────────────────────
      const primaryClicked = await clickPrimaryConnectBtn();
      if (primaryClicked) {
        await page.waitForTimeout(2_000);  // let modal animate in
      } else {
        log.push('[wallet] No "Connect Wallet" button found — checking if modal already open');
      }

      // ── Step 2: Privy "Continue with a wallet" ───────────────────────────
      // Privy shows a "Log in or sign up" modal with social logins first.
      // Always check for this button regardless of detected stack — many sites
      // use wagmi-appkit or rainbowkit with Privy as the auth layer underneath.
      const privyContinueBtn = page.locator('button, [role="button"]')
          .filter({ hasText: /continue with a wallet|continue with wallet/i })
          .first();

      const privyVisible = await privyContinueBtn.isVisible({ timeout: 2_000 }).catch(() => false);
      if (privyVisible) {
        await privyContinueBtn.click().catch(() => {});
        log.push('[wallet] Clicked "Continue with a wallet" (Privy social modal)');
        // Privy needs time to detect window.ethereum.isMetaMask and render the
        // short injected-wallet picker instead of the full WalletConnect list.
        await page.waitForTimeout(4_000);

        const isFullWcList = await page.evaluate(() =>
          /search through \d+ wallets/i.test(document.body?.innerText ?? ''),
        ).catch(() => false);

        if (isFullWcList) {
          log.push('[wallet] WalletConnect full list shown — re-announcing EIP-6963 and waiting');
          await page.evaluate(() => {
            window.dispatchEvent(new Event('eip6963:requestProvider'));
          }).catch(() => {});
          await page.waitForTimeout(3_000);

          const stillFullList = await page.evaluate(() =>
            /search through \d+ wallets/i.test(document.body?.innerText ?? ''),
          ).catch(() => false);

          if (stillFullList) {
            log.push('[wallet] Still showing full WalletConnect list — clicking back button and retrying');
            const backBtn = page.locator('button[aria-label*="back" i], button[aria-label*="close" i], [data-testid*="back"]');
            const backVis = await backBtn.first().isVisible({ timeout: 1_000 }).catch(() => false);
            if (backVis) {
              await backBtn.first().click().catch(() => {});
              await page.waitForTimeout(1_000);
            }
          }
        }
      }

      // ── Step 3: wallet picker — MetaMask / Injected / Trust / OKX ────────
      // Skip wallets that require a QR scan, external app, or OAuth.
      const WALLET_PICKER_SKIP = /walletconnect|wallet connect|coinbase wallet|coinbase smart|rainbow|email|phone|google|apple|github|twitter|tiktok|twitch|discord|telegram|farcaster|passkey|social|magic link|web3auth|qr code|scan to connect/i;

      async function tryClickWalletOption(label: string, locator: ReturnType<typeof page.locator>): Promise<boolean> {
        const vis = await locator.isVisible({ timeout: 2_000 }).catch(() => false);
        if (!vis) return false;
        const t = await locator.textContent().catch(() => '');
        await locator.click().catch(() => {});
        log.push(`[wallet] Clicked wallet picker option: "${(t ?? label).trim().slice(0, 50)}"`);
        await page.waitForTimeout(500);
        await page.evaluate(() => {
          const w = window as unknown as Record<string, unknown>;
          if (typeof w['__larpscanTriggerConnect'] === 'function') {
            (w['__larpscanTriggerConnect'] as () => void)();
          }
        }).catch(() => {});
        await page.waitForTimeout(4_000);
        return true;
      }

      // Ordered preference: Phantom → Solflare → Backpack → generic wallet-adapter
      const pickerClicked =
        await tryClickWalletOption('Phantom',
          page.locator('button, [role="button"], li, div[role="option"]').filter({ hasText: /^phantom$/i }).first(),
        ) ||
        await tryClickWalletOption('Phantom',
          page.locator('button, [role="button"], li, div[role="option"]').filter({ hasText: /phantom/i }).first(),
        ) ||
        await tryClickWalletOption('Solflare',
          page.locator('button, [role="button"], li, div[role="option"]').filter({ hasText: /solflare/i }).first(),
        ) ||
        await tryClickWalletOption('Backpack',
          page.locator('button, [role="button"], li, div[role="option"]').filter({ hasText: /backpack/i }).first(),
        ) ||
        // Generic fallback: any wallet-modal button that isn't a social/QR option
        await (async () => {
          const modalBtns = page.locator(
            '[role="dialog"] button, dialog button, ' +
            '[data-privy-dialog] button, [data-rk] button, ' +
            '[class*="WalletModal"] button, [class*="walletModal"] button, ' +
            '[class*="wallet-list"] button, [class*="connectorList"] button, ' +
            '[class*="w3m-"] button, [class*="ck-"] button, ' +
            '[data-testid*="wallet"] button, [class*="dynamic-"] button, ' +
            '[class*="tw-connect"] button, [class*="thirdweb"] button, ' +
            '[class*="modal"] button, [class*="Modal"] button, ' +
            '[class*="overlay"] button, [class*="Overlay"] button',
          );
          const count = await modalBtns.count().catch(() => 0);
          for (let i = 0; i < count; i++) {
            const btn = modalBtns.nth(i);
            const vis = await btn.isVisible().catch(() => false);
            if (!vis) continue;
            const rawTxt = (await btn.textContent().catch(() => '') ?? '');
            const txt = rawTxt.replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
            if (txt && txt.length >= 3 && /[a-zA-Z]{2,}/.test(txt) && !WALLET_PICKER_SKIP.test(txt)) {
              await btn.click().catch(() => {});
              log.push(`[wallet] Clicked fallback modal option: "${txt.slice(0, 50)}"`);
              await page.waitForTimeout(4_000);

              // If the fallback clicked a Privy "Continue with a wallet" transition,
              // a new wallet picker may have appeared — try MetaMask/Injected now.
              if (/continue with/i.test(txt)) {
                log.push('[wallet] Fallback transition — looking for Phantom in new picker');
                await triggerWalletReconnect(page, { waitMs: 2_000 });
                const phantomClicked = await tryClickWalletOption('Phantom (post-modal)',
                  page.locator('button, [role="button"], li, div[role="option"]').filter({ hasText: /phantom/i }).first(),
                );
                if (!phantomClicked) {
                  await tryClickWalletOption('Solflare (post-modal)',
                    page.locator('button, [role="button"], li, div[role="option"]').filter({ hasText: /solflare/i }).first(),
                  );
                }
              }
              return true;
            }
          }
          return false;
        })();

      // ── Step 4: Retry with backoff — re-announce EIP-6963 and retry if first pass failed
      if (!pickerClicked) {
        const retryDelays = [2_000, 3_000, 4_000]; // exponential-ish backoff
        let retrySuccess = false;

        for (let attempt = 0; attempt < retryDelays.length && !retrySuccess; attempt++) {
          log.push(`[wallet] Retry attempt ${attempt + 1}/${retryDelays.length} — re-announcing EIP-6963`);

          await triggerWalletReconnect(page, { waitMs: retryDelays[attempt]! });

          // On first retry, try clicking the primary connect button again
          if (attempt === 0 && !primaryClicked) {
            const clicked = await clickPrimaryConnectBtn();
            if (clicked) await page.waitForTimeout(2_000);
          }

          // Try MetaMask first, then any visible wallet option
          retrySuccess = await tryClickWalletOption(`Phantom (retry ${attempt + 1})`,
            page.locator('button, [role="button"], li').filter({ hasText: /phantom/i }).first(),
          );
          if (!retrySuccess) {
            retrySuccess = await tryClickWalletOption(`Injected (retry ${attempt + 1})`,
              page.locator('button, [role="button"], li').filter({ hasText: /injected|browser wallet|detected/i }).first(),
            );
          }
        }

        if (retrySuccess) {
          log.push('[wallet] Wallet picker clicked on retry');
        } else {
          log.push('[wallet] All retries exhausted — firing triggerWalletReconnect as last resort');
          await triggerWalletReconnect(page, { waitMs: 3_000 });
        }
      }

      // ── Confirmation: wait for signing bridge round-trip + DOM update ────
      // wagmi/RainbowKit: eth_requestAccounts → personal_sign → re-render.
      // Privy: personal_sign → auth.privy.io validate → re-render.
      // Budget: 6s covers both slow paths, then retry once if not yet confirmed.
      await page.waitForTimeout(6_000);

      const confirmShort = walletAddress.slice(0, 6).toLowerCase();
      const confirmEnd   = walletAddress.slice(-4).toLowerCase();

      // Multi-signal connection confirmation
      const connectionStatus = await page.evaluate(
        ({ short, end }: { short: string; end: string }) => {
          const text = document.body?.innerText?.toLowerCase() ?? '';
          const signals: string[] = [];

          // Signal 1: wallet address visible in DOM
          if (text.includes(short) && text.includes(end)) signals.push('address_full');
          const truncRe = new RegExp(short + '[.…]{2,}' + end);
          if (truncRe.test(text)) signals.push('address_truncated');

          // Signal 2: connect button disappeared
          const connectBtns = Array.from(document.querySelectorAll('button, [role="button"]'))
            .filter((el) => {
              const t = ((el as HTMLElement).innerText ?? '').toLowerCase().trim();
              const s = window.getComputedStyle(el as Element);
              return s.display !== 'none' && s.visibility !== 'hidden' &&
                /^connect wallet$|^connect$|^connect your wallet$/i.test(t);
            });
          if (connectBtns.length === 0) signals.push('no_connect_btn');

          // Signal 3: disconnect/logout button appeared (strong positive signal)
          const disconnectBtns = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"]'))
            .filter((el) => {
              const t = ((el as HTMLElement).innerText ?? '').toLowerCase().trim();
              return /disconnect|log ?out|sign ?out/i.test(t);
            });
          if (disconnectBtns.length > 0) signals.push('disconnect_btn');

          // Signal 4: profile/avatar/account UI elements
          const profileEl = document.querySelector(
            '[class*="avatar" i], [class*="profile" i], [data-testid*="account"], ' +
            '[class*="account-info" i], [class*="user-menu" i], [class*="wallet-info" i], ' +
            '[class*="identicon" i], [class*="jazzicon" i], [class*="blockie" i]'
          );
          if (profileEl) signals.push('profile_ui');

          // Signal 5: auth token in storage
          try {
            const hasAuthToken =
              !!localStorage.getItem('privy:token') ||
              !!localStorage.getItem('privy:session') ||
              !!sessionStorage.getItem('privy:token') ||
              !!localStorage.getItem('auth_token') ||
              !!localStorage.getItem('access_token') ||
              !!localStorage.getItem('jwt') ||
              !!sessionStorage.getItem('auth_token');
            if (hasAuthToken) signals.push('auth_token');
          } catch(e) {}

          // Signal 6: wagmi store shows connected
          try {
            var wagmi = localStorage.getItem('wagmi.store');
            if (wagmi && wagmi.includes('"current"') && !wagmi.includes('"current":null')) {
              signals.push('wagmi_connected');
            }
          } catch(e) {}

          // Negative signals
          const authModalVisible =
            /log in or sign up/i.test(text) ||
            /login with twitter|login with github|login with tiktok|login with twitch|login with discord/i.test(text) ||
            /continue with a wallet/i.test(text) ||
            /create an account/i.test(text) ||
            /sign up to continue/i.test(text);

          const errorVisible =
            /connection failed|connection rejected|user rejected|user denied/i.test(text) ||
            /wallet connection error|failed to connect/i.test(text);

          return {
            signals,
            authModalVisible,
            errorVisible,
            pageLength: text.length,
          };
        },
        { short: confirmShort, end: confirmEnd },
      ).catch(() => ({ signals: [] as string[], authModalVisible: false, errorVisible: false, pageLength: 0 }));

      log.push(`[wallet] Connection signals: [${connectionStatus.signals.join(', ')}]`);

      const hasStrongPositive = connectionStatus.signals.some(
        (s) => s === 'address_full' || s === 'address_truncated' || s === 'disconnect_btn' || s === 'auth_token',
      );
      const hasWeakPositive = connectionStatus.signals.some(
        (s) => s === 'no_connect_btn' || s === 'profile_ui' || s === 'wagmi_connected',
      );
      const weakPositiveCount = connectionStatus.signals.filter(
        (s) => s === 'no_connect_btn' || s === 'profile_ui' || s === 'wagmi_connected',
      ).length;

      if (connectionStatus.authModalVisible) {
        walletConnected = false;
        log.push('[wallet] Auth/login modal still visible — wallet NOT connected');
      } else if (connectionStatus.errorVisible) {
        walletConnected = false;
        log.push('[wallet] Connection error visible in DOM — wallet NOT connected');
      } else if (hasStrongPositive) {
        walletConnected = true;
        log.push('[wallet] Wallet connected confirmed — strong signal in DOM');
      } else if (weakPositiveCount >= 2) {
        // Two weak signals together (e.g. no connect button + profile UI) are sufficient
        walletConnected = true;
        log.push('[wallet] Wallet connected confirmed — multiple weak signals in DOM');
      } else if (hasWeakPositive && pickerClicked) {
        // If we clicked a picker option AND have at least one weak signal, retry once
        log.push('[wallet] Weak signal detected, retrying confirmation in 5s...');
        await page.waitForTimeout(5_000);
        const retryCheck = await page.evaluate(
          ({ short, end }: { short: string; end: string }) => {
            const text = document.body?.innerText?.toLowerCase() ?? '';

            // Check 1: wallet address visible
            if (text.includes(short) || text.includes(end)) return 'address_visible';
            const truncRe = new RegExp(short + '[.…]{2,}' + end);
            if (truncRe.test(text)) return 'truncated_address';

            // Check 2: avatar/identicon appeared
            if (document.querySelector('[class*="avatar" i], [class*="identicon" i], [class*="jazzicon" i], [class*="blockie" i]')) {
              return 'avatar_visible';
            }

            // Check 3: auth modal gone AND connect button gone (strong combined signal)
            const authModalGone = !/log in or sign up|continue with a wallet|create an account/i.test(text);
            const connectBtns = Array.from(document.querySelectorAll('button, [role="button"]'))
              .filter((el) => {
                const t = ((el as HTMLElement).innerText ?? '').toLowerCase().trim();
                const s = window.getComputedStyle(el as Element);
                return s.display !== 'none' && s.visibility !== 'hidden' &&
                  /^connect wallet$|^connect$|^connect your wallet$/i.test(t);
              });
            if (authModalGone && connectBtns.length === 0 && text.length > 200) {
              return 'modal_gone_no_connect_btn';
            }

            // Check 4: Privy session token appeared
            try {
              if (localStorage.getItem('privy:token') || localStorage.getItem('privy:session') ||
                  sessionStorage.getItem('privy:token')) {
                return 'privy_session';
              }
            } catch {}

            // Check 5: wagmi store shows connected with an account
            try {
              const wagmi = localStorage.getItem('wagmi.store');
              if (wagmi) {
                const parsed = JSON.parse(wagmi);
                const state = parsed?.state;
                if (state?.current && state.current !== 'null') return 'wagmi_account';
              }
            } catch {}

            // Check 6: disconnect/logout button appeared
            const disconnectBtns = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"]'))
              .filter((el) => /disconnect|log ?out|sign ?out/i.test(((el as HTMLElement).innerText ?? '').toLowerCase().trim()));
            if (disconnectBtns.length > 0) return 'disconnect_btn';

            return null;
          },
          { short: confirmShort, end: confirmEnd },
        ).catch(() => null);
        if (retryCheck) {
          walletConnected = true;
          log.push(`[wallet] Wallet connected confirmed on retry — signal: ${retryCheck}`);
        } else {
          walletConnected = false;
          log.push('[wallet] Wallet connection not confirmed after retry');
        }
      } else {
        walletConnected = false;
        log.push(
          pickerClicked
            ? '[wallet] Wallet picker clicked but connection not confirmed in DOM — NOT marking connected'
            : '[wallet] Wallet injection active but connection not confirmed in DOM — NOT marking connected',
        );
      }
    } else {
      rejectedRequests.push(ctx);
    }
  }

  // ── Detect transaction / sign prompts (in-page, not browser extension) ──
  const txPrompts = await page.evaluate(() => {
    const dangerKeywords = [
      'confirm transaction', 'approve spending', 'execute swap',
      'unlimited approval', 'spend limit', 'token allowance',
      '確認交易', '批准支出', '執行兌換', '無限授權',
    ];
    const bodyText = document.body?.innerText ?? '';
    return dangerKeywords.filter((kw) => bodyText.toLowerCase().includes(kw.toLowerCase()));
  }).catch(() => [] as string[]);

  if (txPrompts.length > 0) {
    const popup: InterceptedWalletPopup = {
      popupType:   'transaction',
      visibleText: txPrompts.join(', '),
      originUrl:   page.url(),
      rawData:     { detectedPrompts: txPrompts },
    };

    const ctx = classifyWalletRequest(popup, claimFeatureType, workflowStage);
    detectedRequests.push(ctx);

    const decision = evaluatePolicy(policy, {
      actionType: 'sign_transaction',
      totalSpentThisRunSol: spentSolThisRun,
      valueSol: 0,
    });

    log.push(
      `[wallet] In-page tx prompt detected ("${txPrompts[0]?.slice(0, 60)}") ` +
      `→ policy: ${decision.allowed ? 'ALLOW' : 'REJECT'} — ${decision.reason}`,
    );

    if (!decision.allowed) {
      rejectedRequests.push(ctx);
    }
  }

  return { detectedRequests, walletConnected, rejectedRequests, log };
}

/**
 * Builds a raw JavaScript string that, when injected into a page, installs a
 * fully-functional window.ethereum mock for the given wallet address.
 *
 * We use a raw JS string (not a TypeScript closure) because Playwright
 * serialises callbacks via .toString() — TypeScript type-annotation artifacts
 * inside closures can cause the script to fail silently in the browser.
 */
function buildWalletMockScript(pubkey: string): string {
  const safeKey = pubkey.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');

  return `
(function() {
  if (window.__larpscanMockInstalled) return;
  window.__larpscanMockInstalled = true;

  var pubkeyStr = "${safeKey}";

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  var mockPublicKey = {
    toString: function() { return pubkeyStr; },
    toBase58: function() { return pubkeyStr; },
    toBytes: function() { return b64ToBytes(btoa(pubkeyStr.slice(0, 32))); },
    toBuffer: function() { return b64ToBytes(btoa(pubkeyStr.slice(0, 32))); }
  };

  var phantom = {
    isPhantom: true,
    isConnected: true,
    publicKey: mockPublicKey,

    connect: async function(opts) {
      console.log('[mock] solana.connect');
      setTimeout(function() {
        window.dispatchEvent(new Event('connect'));
      }, 50);
      return { publicKey: mockPublicKey };
    },

    disconnect: async function() {
      console.log('[mock] solana.disconnect');
      return undefined;
    },

    signMessage: async function(message, encoding) {
      console.log('[mock] solana.signMessage');
      if (typeof window.larpscanSign !== 'function') {
        throw { code: 4001, message: 'LarpScan: no signing bridge' };
      }
      var msgStr = typeof message === 'string'
        ? message
        : Array.from(message).map(function(c){ return String.fromCharCode(c); }).join('');
      var sigB64 = await window.larpscanSign('solana_signMessage', JSON.stringify({
        message: msgStr,
        encoding: encoding || 'utf8'
      }));
      return { signature: b64ToBytes(sigB64), publicKey: mockPublicKey };
    },

    signTransaction: async function(transaction) {
      console.log('[mock] solana.signTransaction');
      if (typeof window.larpscanSign !== 'function') {
        throw { code: 4001, message: 'LarpScan: no signing bridge' };
      }
      var serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
      var txB64 = btoa(String.fromCharCode.apply(null, Array.from(serialized)));
      var signedB64 = await window.larpscanSign('solana_signTransaction', JSON.stringify({ transaction: txB64 }));
      return transaction;
    },

    signAndSendTransaction: async function(transaction, opts) {
      console.log('[mock] solana.signAndSendTransaction');
      if (typeof window.larpscanSign !== 'function') {
        throw { code: 4001, message: 'LarpScan: no signing bridge' };
      }
      var serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
      var txB64 = btoa(String.fromCharCode.apply(null, Array.from(serialized)));
      var sig = await window.larpscanSign('solana_signAndSendTransaction', JSON.stringify({ transaction: txB64 }));
      return { signature: sig };
    },

    signAllTransactions: async function(transactions) {
      var out = [];
      for (var i = 0; i < transactions.length; i++) {
        out.push(await phantom.signTransaction(transactions[i]));
      }
      return out;
    },

    on: function(event, cb) {
      if (!this._listeners) this._listeners = {};
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(cb);
      return this;
    },
    removeListener: function(event, cb) {
      if (this._listeners && this._listeners[event]) {
        this._listeners[event] = this._listeners[event].filter(function(f) { return f !== cb; });
      }
      return this;
    }
  };

  try {
    Object.defineProperty(window, 'solana', {
      get: function() { return phantom; },
      set: function(v) { console.log('[mock] solana override ignored'); },
      configurable: false,
      enumerable: true
    });
  } catch(e) {
    window.solana = phantom;
  }

  window.phantom = { solana: phantom };

  try {
    localStorage.setItem('walletName', '"Phantom"');
    localStorage.setItem('@solana/wallet-adapter-react', JSON.stringify({
      wallet: { adapter: { name: 'Phantom', publicKey: pubkeyStr, connected: true } }
    }));
  } catch(lsErr) {
    console.log('[mock] localStorage write failed:', lsErr && lsErr.message);
  }

  window.__larpscanTriggerConnect = function() {
    phantom.connect().catch(function(){});
  };

  console.log('[mock] Phantom wallet mock installed:', pubkeyStr);
})();
`;
}

/**
 * Inject Phantom wallet mock into a browser context before page navigation.
 */
export async function injectWalletMockIntoContext(
  context:       BrowserContext,
  walletAddress: string,
): Promise<void> {
  const script = buildWalletMockScript(walletAddress);
  await context.addInitScript(script);
  console.log(`[executor] Solana wallet mock injected for ${walletAddress}`);
}
