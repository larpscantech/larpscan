import { NextRequest } from 'next/server';
import { validateContract, getTokenMetadata, rpcClient } from '@/lib/rpc';
import { supabase } from '@/lib/supabase';
import { ok, err, withErrorHandler } from '@/lib/api-helpers';
import { parseAbi, getAddress } from 'viem';
import type { Address } from 'viem';
import type { DbProject } from '@/lib/db-types';

// ─── Shared result shape ──────────────────────────────────────────────────────

interface Enrichment {
  website: string | null;
  twitter: string | null;
  logoUrl: string | null;
  source?: string;
}

const EMPTY: Enrichment = { website: null, twitter: null, logoUrl: null };

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

// ─── Source 1: DexScreener ────────────────────────────────────────────────────

interface DexPair {
  info?: {
    imageUrl?: string;
    websites?: { url: string }[];
    socials?: { type: string; url: string }[];
  };
}

async function getDexScreenerData(address: string): Promise<Enrichment> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${address}`,
      { next: { revalidate: 300 } },
    );
    if (!res.ok) return EMPTY;

    const data = await res.json() as { pairs?: DexPair[] | null };
    const pairs = data.pairs ?? [];
    const pair  = pairs.find((p) => p.info) ?? pairs[0];
    const info  = pair?.info;

    return {
      website: info?.websites?.[0]?.url ?? null,
      twitter: normalizeTwitter(info?.socials?.find((s) => s.type === 'twitter')?.url),
      logoUrl: info?.imageUrl ?? null,
      source:  'dexscreener',
    };
  } catch {
    return EMPTY;
  }
}

// ─── Source 2: On-chain metadata via NodeReal RPC ─────────────────────────────
// Many BSC tokens expose website/twitter as public view functions on the contract.

const WEBSITE_FUNCTIONS  = ['website', 'projectWebsite', 'getWebsite', 'siteURL', 'websiteURL'] as const;
const TWITTER_FUNCTIONS  = ['twitter', 'getTwitter', 'twitterLink', 'twitterURL', 'twitterHandle'] as const;
const TELEGRAM_FUNCTIONS = ['telegram', 'getTelegram', 'telegramLink', 'telegramURL'] as const;

async function tryReadString(address: Address, fn: string): Promise<string | null> {
  try {
    const result = await rpcClient.readContract({
      address,
      abi:          parseAbi([`function ${fn}() view returns (string)`]),
      functionName: fn,
    });
    const str = (result as string)?.trim();
    return str || null;
  } catch {
    return null;
  }
}

async function probeMetadataFunctions(
  address: Address,
  candidates: readonly string[],
): Promise<string | null> {
  const results = await Promise.all(candidates.map((fn) => tryReadString(address, fn)));
  return results.find((r) => r !== null) ?? null;
}

async function getOnChainMetadata(address: string): Promise<Enrichment> {
  const addr = address as Address;

  const [website, twitterRaw, telegramRaw] = await Promise.all([
    probeMetadataFunctions(addr, WEBSITE_FUNCTIONS),
    probeMetadataFunctions(addr, TWITTER_FUNCTIONS),
    probeMetadataFunctions(addr, TELEGRAM_FUNCTIONS),
  ]);

  if (telegramRaw) console.log('[discover] On-chain telegram:', telegramRaw);

  return {
    website: website || null,
    twitter: normalizeTwitter(twitterRaw) || null,
    logoUrl: null,
    source:  'on-chain',
  };
}

// ─── Source 3: GeckoTerminal ──────────────────────────────────────────────────
// Free, no API key. Good coverage of tokens with any DEX activity on BSC.

interface GeckoTerminalAttributes {
  websites?:       string[];
  twitter_handle?: string;
  telegram_handle?: string;
  image_url?:      string;
}

async function getGeckoTerminalData(address: string): Promise<Enrichment> {
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/bsc/tokens/${address}/info`,
      {
        headers: { Accept: 'application/json' },
        next: { revalidate: 600 },
      },
    );
    if (!res.ok) return EMPTY;

    const data = await res.json() as { data?: { attributes?: GeckoTerminalAttributes } };
    const attr = data.data?.attributes;
    if (!attr) return EMPTY;

    const website = attr.websites?.find((w) => w?.trim()) ?? null;
    const twitter = normalizeTwitter(attr.twitter_handle);

    return {
      website: website || null,
      twitter: twitter  || null,
      logoUrl: attr.image_url || null,
      source:  'geckoterminal',
    };
  } catch {
    return EMPTY;
  }
}

// ─── Source 4: Moralis ERC20 metadata ────────────────────────────────────────
// Provides verified logos, spam detection, and token metadata.
// Free tier at moralis.io — requires MORALIS_API_KEY.

interface MoralisTokenMeta {
  name?:             string;
  symbol?:           string;
  logo?:             string | null;
  thumbnail?:        string | null;
  verified_contract?: boolean;
  possible_spam?:    boolean;
  links?: {
    website?: string;
    twitter?:  string;
    telegram?: string;
  };
}

async function getMoralisData(address: string): Promise<Enrichment> {
  try {
    const apiKey = process.env.MORALIS_API_KEY;
    if (!apiKey || apiKey === 'your-moralis-api-key') return EMPTY;

    const url = `https://deep-index.moralis.io/api/v2.2/erc20/metadata?chain=bsc&addresses[0]=${address}`;

    const res = await fetch(url, {
      headers: {
        'Accept':    'application/json',
        'X-API-Key': apiKey,
      },
      next: { revalidate: 600 },
    });

    if (!res.ok) return EMPTY;

    const data = await res.json() as MoralisTokenMeta[];
    const meta = Array.isArray(data) ? data[0] : undefined;
    if (!meta) return EMPTY;

    // Log if token is flagged as spam — useful signal for ChainVerify
    if (meta.possible_spam) {
      console.log('[discover] Moralis flagged as possible spam:', address);
    }

    return {
      website: meta.links?.website?.trim() || null,
      twitter: normalizeTwitter(meta.links?.twitter),
      logoUrl: meta.logo || meta.thumbnail || null,
      source:  'moralis',
    };
  } catch {
    return EMPTY;
  }
}

// ─── Source 5: Trust Wallet Assets ────────────────────────────────────────────
// Free GitHub-hosted metadata. Covers thousands of BSC tokens that Trust Wallet
// has manually verified. Uses checksummed address as the folder name.

interface TrustWalletInfo {
  website?: string;
  links?:   { name: string; url: string }[];
  logo?:    string;
}

async function getTrustWalletData(address: string): Promise<Enrichment> {
  try {
    // Trust Wallet requires EIP-55 checksummed address
    const checksummed = getAddress(address);
    const url = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/assets/${checksummed}/info.json`;

    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) return EMPTY;

    const info = await res.json() as TrustWalletInfo;

    const twitterLink = info.links?.find((l) => l.name?.toLowerCase() === 'twitter')?.url;

    return {
      website: info.website?.trim() || null,
      twitter: normalizeTwitter(twitterLink),
      logoUrl: info.logo || null,
      source:  'trustwallet',
    };
  } catch {
    return EMPTY;
  }
}

// ─── Merge: fill each field from best available source ────────────────────────

function merge(...sources: Enrichment[]): Enrichment & { source: string } {
  const out = { ...EMPTY, source: '' };
  const used: string[] = [];

  for (const src of sources) {
    if (!out.website && src.website) { out.website = src.website; used.push(`website:${src.source}`); }
    if (!out.twitter && src.twitter) { out.twitter = src.twitter; used.push(`twitter:${src.source}`); }
    if (!out.logoUrl && src.logoUrl) { out.logoUrl = src.logoUrl; used.push(`logo:${src.source}`); }
  }

  out.source = used.length ? used.join(', ') : 'none';
  return out;
}

// ─── Route handler ────────────────────────────────────────────────────────────

export const POST = withErrorHandler(async (req: Request) => {
  const body            = await (req as NextRequest).json().catch(() => ({}));
  const contractAddress = (body?.contractAddress ?? '').trim();

  if (!contractAddress) return err('contractAddress is required');

  // 1. Validate bytecode on-chain
  await validateContract(contractAddress);

  // 2. Read ERC-20 name + symbol via RPC
  const { name, symbol } = await getTokenMetadata(contractAddress);
  console.log('[discover] On-chain token:', { name, symbol });

  // 3. All five enrichment sources fire in parallel — no waiting on each other
  const [dex, onChain, gecko, moralis, trustWallet] = await Promise.all([
    getDexScreenerData(contractAddress),
    getOnChainMetadata(contractAddress),
    getGeckoTerminalData(contractAddress),
    getMoralisData(contractAddress),
    getTrustWalletData(contractAddress),
  ]);

  console.log('[discover] DexScreener   :', dex);
  console.log('[discover] On-chain      :', onChain);
  console.log('[discover] GeckoTerminal :', gecko);
  console.log('[discover] Moralis       :', moralis);
  console.log('[discover] TrustWallet   :', trustWallet);

  const enrichment = merge(dex, onChain, gecko, moralis, trustWallet);
  console.log('[discover] Final result  :', enrichment);

  // 4. Upsert to Supabase
  const { data, error } = await supabase
    .from('projects')
    .upsert(
      {
        contract_address: contractAddress.toLowerCase(),
        name,
        symbol,
        website:  enrichment.website,
        twitter:  enrichment.twitter,
        logo_url: enrichment.logoUrl,
        chain:    'bsc',
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
