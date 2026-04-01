import { NextRequest } from 'next/server';
import { validateContract, getTokenMetadata, rpcClient } from '@/lib/rpc';
import { supabase } from '@/lib/supabase';
import { ok, err, withErrorHandler } from '@/lib/api-helpers';
import { parseAbi, getAddress } from 'viem';
import type { Address } from 'viem';
import type { DbProject } from '@/lib/db-types';

// ─── URL redirect resolution ──────────────────────────────────────────────────
// Follow redirect chains so we store clean final URLs, not t.co / bit.ly wrappers.

const SHORT_LINK_HOSTS_DISCOVER = new Set([
  't.co', 'bit.ly', 'tinyurl.com', 'ow.ly', 'buff.ly', 'rebrand.ly',
  'short.io', 'cutt.ly', 'rb.gy', 'lnkd.in', 'linktr.ee', 'beacons.ai',
]);

function isShortLinkDiscover(url: string | null | undefined): boolean {
  if (!url) return false;
  try { return SHORT_LINK_HOSTS_DISCOVER.has(new URL(url).hostname); } catch { return false; }
}

async function resolveWebsiteUrl(url: string | null): Promise<string | null> {
  if (!url) return null;
  if (!isShortLinkDiscover(url)) return url;
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
      const final = res.url;
      if (final && final !== url) console.log(`[discover] Resolved short URL: ${url} → ${final}`);
      return final || url;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return url;
  }
}

// ─── Shared result shape ──────────────────────────────────────────────────────

interface Enrichment {
  website:     string | null;
  twitter:     string | null;
  logoUrl:     string | null;
  description: string | null;
  source?: string;
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
      website:     info?.websites?.[0]?.url ?? null,
      twitter:     normalizeTwitter(info?.socials?.find((s) => s.type === 'twitter')?.url),
      logoUrl:     info?.imageUrl ?? null,
      description: null,
      source:      'dexscreener',
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
    website:     website || null,
    twitter:     normalizeTwitter(twitterRaw) || null,
    logoUrl:     null,
    description: null,
    source:      'on-chain',
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
      website:     website || null,
      twitter:     twitter  || null,
      logoUrl:     attr.image_url || null,
      description: null,
      source:      'geckoterminal',
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

    // Log if token is flagged as spam — useful signal for LarpScan
    if (meta.possible_spam) {
      console.log('[discover] Moralis flagged as possible spam:', address);
    }

    return {
      website:     meta.links?.website?.trim() || null,
      twitter:     normalizeTwitter(meta.links?.twitter),
      logoUrl:     meta.logo || meta.thumbnail || null,
      description: null,
      source:      'moralis',
    };
  } catch {
    return EMPTY;
  }
}

// ─── Source 5: FLAP launchpad (metaURI → IPFS) ───────────────────────────────
// Tokens launched on flap.sh expose metaURI() which returns an IPFS CID.
// The CID points to a JSON blob containing website, twitter, telegram,
// description and an image CID. All fetched from the Pinata gateway.

const FLAP_GATEWAY  = 'https://flap.mypinata.cloud/ipfs';
const META_URI_ABI  = parseAbi(['function metaURI() view returns (string)']);

interface FlapMeta {
  description?: string | null;
  website?:     string | null;
  twitter?:     string | null;
  telegram?:    string | null;
  image?:       string | null;
}

async function getFlapData(address: string): Promise<Enrichment> {
  try {
    const addr = address as Address;

    // 1. Read metaURI() from the token contract
    const cid = await rpcClient
      .readContract({ address: addr, abi: META_URI_ABI, functionName: 'metaURI' })
      .catch(() => null) as string | null;

    if (!cid || !cid.startsWith('bafy') && !cid.startsWith('bafk')) return EMPTY;

    // 2. Fetch the metadata JSON from Pinata gateway
    const metaRes = await fetch(`${FLAP_GATEWAY}/${cid}`, {
      next: { revalidate: 3600 },
    });
    if (!metaRes.ok) return EMPTY;

    const meta = await metaRes.json() as FlapMeta;

    // 3. Resolve image CID → full URL
    let logoUrl: string | null = null;
    if (meta.image && (meta.image.startsWith('bafy') || meta.image.startsWith('bafk'))) {
      logoUrl = `${FLAP_GATEWAY}/${meta.image}`;
    } else if (meta.image?.startsWith('http')) {
      logoUrl = meta.image;
    }

    const website  = meta.website?.trim()  || null;
    const twitter  = normalizeTwitter(meta.twitter);
    const description = meta.description?.trim() || null;

    console.log('[discover] FLAP meta CID:', cid, '→', { website, twitter, logoUrl, description });

    return { website, twitter, logoUrl, description, source: 'flap' };
  } catch (e) {
    console.warn('[discover] FLAP fetch failed:', e);
    return EMPTY;
  }
}

// ─── Source 6: Trust Wallet Assets ────────────────────────────────────────────
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
      website:     info.website?.trim() || null,
      twitter:     normalizeTwitter(twitterLink),
      logoUrl:     info.logo || null,
      description: null,
      source:      'trustwallet',
    };
  } catch {
    return EMPTY;
  }
}

// ─── Source 7: four.meme launchpad API ───────────────────────────────────────
// four.meme exposes a token info API that returns socials, description, and logo
// for any token created via their TokenManager V1/V2 contracts.
// API: https://four.meme/meme-api/v1/private/token/get?address={address}
// Detection: if code === "0" and data is non-null, this is a four.meme token.
// The TokenManager V2 address: 0x5c952063c7fc8610FFDB798152D69F0B9550762b
// The TokenManager V1 address: 0xEC4549caDcE5DA21Df6E6422d448034B5233bFbC

const FOUR_MEME_API = 'https://four.meme/meme-api/v1/private/token/get';
const FOUR_MEME_TOKEN_MANAGER_V2 = '0x5c952063c7fc8610ffdb798152d69f0b9550762b';
const FOUR_MEME_TOKEN_MANAGER_V1 = '0xec4549cadce5da21df6e6422d448034b5233bfbc';

// four.meme token info struct — fields vary; we try all known names
interface FourMemeTokenData {
  address?:      string;
  name?:         string;
  symbol?:       string;
  description?:  string | null;
  // logo / image — different API versions use different field names
  logo?:         string | null;
  image?:        string | null;
  imageUrl?:     string | null;
  icon?:         string | null;
  // social links — also varies
  twitter?:      string | null;
  twitterUrl?:   string | null;
  twitterLink?:  string | null;
  telegram?:     string | null;
  telegramUrl?:  string | null;
  telegramLink?: string | null;
  website?:      string | null;
  websiteUrl?:   string | null;
  websiteLink?:  string | null;
  // extra fields from docs used for token type identification
  version?:      string | null;
  feePlan?:      boolean | null;
  aiCreator?:    boolean | null;
  taxInfo?:      Record<string, unknown> | null;
}

interface FourMemeResponse {
  code: string;
  data: FourMemeTokenData | null;
}

// On-chain detection: TokenManager V2 exposes _tokenInfos(token) which returns
// a struct — if the token is not managed by V2, the call reverts or returns zeros.
const FOUR_MEME_MANAGER_ABI = parseAbi([
  'function _tokenInfos(address token) external view returns (address base, address quote, uint256 template, uint256 totalSupply, uint256 maxOffers, uint256 maxRaising, uint256 launchTime, uint256 offers, uint256 funds, uint256 lastPrice, uint256 K, uint256 T, uint256 status)',
]);

async function isFourMemeToken(address: string): Promise<boolean> {
  try {
    const result = await rpcClient.readContract({
      address: FOUR_MEME_TOKEN_MANAGER_V2 as Address,
      abi: FOUR_MEME_MANAGER_ABI,
      functionName: '_tokenInfos',
      args: [address as Address],
    }) as { status: bigint } | bigint[] | unknown;

    // The struct is returned as an array or named object; check that status is
    // non-zero (0 = not registered in this TokenManager).
    if (Array.isArray(result)) {
      const status = result[12];  // status is index 12
      return BigInt(status as string | number | bigint) > BigInt(0);
    }
    if (result && typeof result === 'object' && 'status' in result) {
      return BigInt((result as { status: bigint | string }).status) > BigInt(0);
    }
    return false;
  } catch {
    return false;
  }
}

function pickFirst(...candidates: (string | null | undefined)[]): string | null {
  for (const c of candidates) {
    if (c && c.trim()) return c.trim();
  }
  return null;
}

async function getFourMemeData(address: string): Promise<Enrichment> {
  try {
    // 1. Quick on-chain probe — skip API call for non-four.meme tokens
    const managed = await isFourMemeToken(address);
    if (!managed) return EMPTY;

    // 2. Fetch rich metadata from the four.meme REST API
    const res = await fetch(`${FOUR_MEME_API}?address=${address}`, {
      headers: { 'Accept': 'application/json' },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return EMPTY;

    const json    = await res.json() as FourMemeResponse;
    if (json.code !== '0' || !json.data) return EMPTY;

    const d = json.data;

    const website     = pickFirst(d.website, d.websiteUrl, d.websiteLink);
    const twitter     = normalizeTwitter(pickFirst(d.twitter, d.twitterUrl, d.twitterLink));
    const logoUrl     = pickFirst(d.logo, d.image, d.imageUrl, d.icon);
    const description = d.description?.trim() || null;

    // Log useful token-type signals for debugging
    if (d.version === 'V8')  console.log('[discover] four.meme: X Mode exclusive token', address);
    if (d.aiCreator)         console.log('[discover] four.meme: AI-agent created token', address);
    if (d.taxInfo)           console.log('[discover] four.meme: TaxToken', address);
    if (d.feePlan)           console.log('[discover] four.meme: AntiSniperFeeMode token', address);

    console.log('[discover] four.meme     :', { website, twitter, logoUrl, description });

    return { website, twitter, logoUrl: logoUrl || null, description, source: 'four.meme' };
  } catch (e) {
    console.warn('[discover] four.meme fetch failed:', e);
    return EMPTY;
  }
}

// ─── Merge: fill each field from best available source ────────────────────────

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

  // 3. All seven enrichment sources fire in parallel — no waiting on each other.
  // Launchpad-native sources (FLAP, four.meme) are first in the merge so their
  // authoritative IPFS/API metadata wins over aggregator guesses.
  const [flap, fourMeme, dex, onChain, gecko, moralis, trustWallet] = await Promise.all([
    getFlapData(contractAddress),
    getFourMemeData(contractAddress),
    getDexScreenerData(contractAddress),
    getOnChainMetadata(contractAddress),
    getGeckoTerminalData(contractAddress),
    getMoralisData(contractAddress),
    getTrustWalletData(contractAddress),
  ]);

  console.log('[discover] FLAP          :', flap);
  console.log('[discover] four.meme     :', fourMeme);
  console.log('[discover] DexScreener   :', dex);
  console.log('[discover] On-chain      :', onChain);
  console.log('[discover] GeckoTerminal :', gecko);
  console.log('[discover] Moralis       :', moralis);
  console.log('[discover] TrustWallet   :', trustWallet);

  // FLAP → four.meme → aggregators: launchpad sources win
  const rawEnrichment = merge(flap, fourMeme, dex, onChain, gecko, moralis, trustWallet);

  // Resolve any short-link website URLs (t.co etc.) to their final destinations
  // so the DB stores the real site and the scraper can extract meaningful content.
  const resolvedWebsite = await resolveWebsiteUrl(rawEnrichment.website);
  const enrichment = { ...rawEnrichment, website: resolvedWebsite };

  console.log('[discover] Final result  :', enrichment);

  // 4. Upsert to Supabase
  const { data, error } = await supabase
    .from('projects')
    .upsert(
      {
        contract_address: contractAddress.toLowerCase(),
        name,
        symbol,
        website:     enrichment.website,
        twitter:     enrichment.twitter,
        logo_url:    enrichment.logoUrl,
        description: enrichment.description,
        chain:       'bsc',
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
