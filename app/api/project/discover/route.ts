import { NextRequest } from 'next/server';
import { validateMint, getTokenMetadata } from '@/lib/solana';
import { supabase } from '@/lib/supabase';
import { ok, err, withErrorHandler } from '@/lib/api-helpers';
import type { DbProject } from '@/lib/db-types';

// ─── URL redirect resolution ──────────────────────────────────────────────────

const SHORT_LINK_HOSTS = new Set([
  't.co', 'bit.ly', 'tinyurl.com', 'ow.ly', 'buff.ly', 'rebrand.ly',
  'short.io', 'cutt.ly', 'rb.gy', 'lnkd.in', 'linktr.ee', 'beacons.ai',
]);

function isShortLink(url: string | null | undefined): boolean {
  if (!url) return false;
  try { return SHORT_LINK_HOSTS.has(new URL(url).hostname); } catch { return false; }
}

async function resolveWebsiteUrl(url: string | null): Promise<string | null> {
  if (!url) return null;
  if (!isShortLink(url)) return url;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LarpScan/1.0)' },
      });
      return res.url || url;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return url;
  }
}

// ─── Enrichment sources ───────────────────────────────────────────────────────

interface Enrichment {
  website:     string | null;
  twitter:     string | null;
  logoUrl:     string | null;
  description: string | null;
  source?:     string;
}

const EMPTY: Enrichment = { website: null, twitter: null, logoUrl: null, description: null };

function normalizeTwitter(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const handle = raw
    .replace(/https?:\/\/(www\.)?(twitter|x)\.com\/?/i, '')
    .replace(/^@/, '')
    .split('?')[0]
    .split('/')[0]
    .trim();
  return handle ? `@${handle}` : null;
}

function merge(...sources: Enrichment[]): Enrichment & { source: string } {
  const out = { ...EMPTY, source: '' };
  const used: string[] = [];
  for (const src of sources) {
    if (!out.website     && src.website)     { out.website     = src.website;     used.push(`website:${src.source}`); }
    if (!out.twitter     && src.twitter)     { out.twitter     = src.twitter;     used.push(`twitter:${src.source}`); }
    if (!out.logoUrl     && src.logoUrl)     { out.logoUrl     = src.logoUrl;     used.push(`logo:${src.source}`); }
    if (!out.description && src.description) { out.description = src.description; used.push(`desc:${src.source}`); }
  }
  out.source = used.length ? used.join(', ') : 'none';
  return out;
}

// Source 1: pump.fun — Solana meme launchpad
async function getPumpFunData(mint: string): Promise<Enrichment> {
  try {
    const res = await fetch(
      `https://frontend-api-v3.pump.fun/coins/${mint}`,
      { next: { revalidate: 300 } },
    );
    if (!res.ok) return EMPTY;

    const d = await res.json() as {
      name?: string;
      symbol?: string;
      description?: string;
      image_uri?: string;
      twitter?: string;
      telegram?: string;
      website?: string;
    };

    return {
      website:     d.website?.trim() || null,
      twitter:     normalizeTwitter(d.twitter),
      logoUrl:     d.image_uri?.trim() || null,
      description: d.description?.trim().slice(0, 400) || null,
      source:      'pump.fun',
    };
  } catch (e) {
    console.warn('[discover] pump.fun fetch failed:', e);
    return EMPTY;
  }
}

// Source 2: DexScreener — cross-DEX aggregator (works for all Solana pools)
interface DexPair {
  info?: {
    imageUrl?: string;
    websites?: { url: string; label?: string }[];
    socials?: { type: string; url: string }[];
    description?: string;
  };
}

async function getDexScreenerData(mint: string): Promise<Enrichment> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { next: { revalidate: 300 } },
    );
    if (!res.ok) return EMPTY;

    const data = await res.json() as { pairs?: DexPair[] | null };
    const pairs = data.pairs ?? [];
    const pair  = pairs.find((p) => p.info) ?? pairs[0];
    const info  = pair?.info;

    const dappLabels = /dapp|app|launch|platform/i;
    const websiteUrl =
      info?.websites?.find((w) => dappLabels.test(w.label ?? ''))?.url ??
      info?.websites?.[0]?.url ??
      null;

    return {
      website:     websiteUrl,
      twitter:     normalizeTwitter(info?.socials?.find((s) => s.type === 'twitter')?.url),
      logoUrl:     info?.imageUrl ?? null,
      description: info?.description?.trim() || null,
      source:      'dexscreener',
    };
  } catch {
    return EMPTY;
  }
}

// Source 3: GeckoTerminal — Solana network token info
async function getGeckoTerminalData(mint: string): Promise<Enrichment> {
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/info`,
      { headers: { Accept: 'application/json' }, next: { revalidate: 600 } },
    );
    if (!res.ok) return EMPTY;

    const data = await res.json() as {
      data?: {
        attributes?: {
          websites?: string[];
          twitter_handle?: string;
          image_url?: string;
        };
      };
    };
    const attr = data.data?.attributes;
    if (!attr) return EMPTY;

    return {
      website:     attr.websites?.find((w) => w?.trim()) ?? null,
      twitter:     normalizeTwitter(attr.twitter_handle),
      logoUrl:     attr.image_url || null,
      description: null,
      source:      'geckoterminal',
    };
  } catch {
    return EMPTY;
  }
}

// Source 4: CoinGecko — description + homepage
async function getCoinGeckoData(mint: string): Promise<Enrichment> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/solana/contract/${mint}`,
      { next: { revalidate: 600 } },
    );
    if (!res.ok) return EMPTY;

    const data = await res.json() as {
      description?: { en?: string };
      links?: { homepage?: string[]; twitter_screen_name?: string };
      image?: { small?: string };
    };

    return {
      website:     data.links?.homepage?.find((u) => u?.startsWith('http')) ?? null,
      twitter:     normalizeTwitter(data.links?.twitter_screen_name),
      logoUrl:     data.image?.small ?? null,
      description: data.description?.en?.trim().slice(0, 400) || null,
      source:      'coingecko',
    };
  } catch {
    return EMPTY;
  }
}

// Source 5: Helius DAS (optional) — rich Metaplex metadata
async function getHeliusData(mint: string): Promise<Enrichment> {
  const apiKey = process.env.HELIUS_API_KEY?.trim();
  if (!apiKey) return EMPTY;

  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'larpscan-discover',
        method: 'getAsset',
        params: { id: mint },
      }),
      next: { revalidate: 600 },
    });
    if (!res.ok) return EMPTY;

    const data = await res.json() as {
      result?: {
        content?: {
          json_uri?: string;
          links?: { external_url?: string; image?: string };
          metadata?: { description?: string; symbol?: string };
        };
      };
    };

    const content = data.result?.content;
    if (!content) return EMPTY;

    let website = content.links?.external_url?.trim() || null;
    let twitter: string | null = null;
    let description = content.metadata?.description?.trim().slice(0, 400) || null;

    // Fetch off-chain JSON if available
    if (content.json_uri) {
      try {
        const metaRes = await fetch(content.json_uri, { next: { revalidate: 3600 } });
        if (metaRes.ok) {
          const meta = await metaRes.json() as {
            external_url?: string;
            website?: string;
            twitter?: string;
            description?: string;
          };
          website = website || meta.external_url || meta.website || null;
          twitter = twitter || normalizeTwitter(meta.twitter);
          description = description || meta.description?.trim().slice(0, 400) || null;
        }
      } catch { /* non-fatal */ }
    }

    return {
      website,
      twitter,
      logoUrl:     content.links?.image?.trim() || null,
      description,
      source:      'helius',
    };
  } catch (e) {
    console.warn('[discover] Helius fetch failed:', e);
    return EMPTY;
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export const POST = withErrorHandler(async (req: Request) => {
  const body            = await (req as NextRequest).json().catch(() => ({}));
  const contractAddress = (body?.contractAddress ?? '').trim();

  if (!contractAddress) return err('contractAddress (Solana mint) is required');

  await validateMint(contractAddress);

  const { name, symbol } = await getTokenMetadata(contractAddress);
  console.log('[discover] On-chain token:', { name, symbol });

  const [pumpFun, dex, gecko, coinGecko, helius] = await Promise.all([
    getPumpFunData(contractAddress),
    getDexScreenerData(contractAddress),
    getGeckoTerminalData(contractAddress),
    getCoinGeckoData(contractAddress),
    getHeliusData(contractAddress),
  ]);

  console.log('[discover] pump.fun     :', pumpFun);
  console.log('[discover] DexScreener  :', dex);
  console.log('[discover] GeckoTerminal:', gecko);
  console.log('[discover] CoinGecko    :', coinGecko);
  console.log('[discover] Helius       :', helius);

  const rawEnrichment = merge(pumpFun, dex, gecko, coinGecko, helius);
  const resolvedWebsite = await resolveWebsiteUrl(rawEnrichment.website);
  const enrichment = { ...rawEnrichment, website: resolvedWebsite };

  console.log('[discover] Final result:', enrichment);

  const { data, error } = await supabase
    .from('projects')
    .upsert(
      {
        contract_address: contractAddress,
        name,
        symbol,
        website:     enrichment.website,
        twitter:     enrichment.twitter,
        logo_url:    enrichment.logoUrl,
        description: enrichment.description,
        chain:       'solana',
      },
      { onConflict: 'contract_address' },
    )
    .select()
    .single<DbProject>();

  if (error) {
    console.error('[discover] Supabase upsert error:', error.message);
    return err('Failed to save project to database', 500);
  }

  return ok({ project: data, enrichmentSource: enrichment.source });
});
