import OpenAI from 'openai';
import type { ExtractedClaim, FeatureType, VerificationStrategy } from './db-types';

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set in environment variables');
  _client = new OpenAI({ apiKey });
  return _client;
}

// ── Enum guards ───────────────────────────────────────────────────────────────

const VALID_FEATURE_TYPES = new Set<FeatureType>([
  'UI_FEATURE', 'DEX_SWAP', 'TOKEN_CREATION', 'API_FEATURE',
  'BOT', 'CLI_TOOL', 'WALLET_FLOW', 'DATA_DASHBOARD',
]);

const VALID_STRATEGIES = new Set<VerificationStrategy>([
  'ui+browser', 'ui+rpc', 'form+browser', 'api+fetch',
  'message+bot', 'terminal+cli', 'wallet+rpc', 'dashboard+browser',
]);

// ── Intermediate type — the model's own product understanding ─────────────────

export interface ProductUnderstanding {
  primary_utility:           string;
  differentiating_mechanism: string;
  main_workflows:            string[];
  secondary_features:        string[];
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a blockchain product analyst and auditor.

Your job is two steps performed in a single response:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — UNDERSTAND THE PRODUCT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Before generating any claims, build a precise understanding of what this product fundamentally does.

Ask yourself:
- What is the primary reason users come to this product?
- What mechanism, algorithm, or economic model makes this product distinct?
- What is the complete user workflow — from entry point to outcome?
- What would be lost if the differentiating mechanism were removed?

Your product_understanding must capture:
- primary_utility: one sentence describing the product's core function for users
- differentiating_mechanism: the key technical or economic mechanism that defines this product's value (e.g. "CPU hash count used as lottery tickets", "trading fees routed to linked social media creator", "automated liquidity rebalancing")
- main_workflows: 1–3 complete user workflows from start to finish
- secondary_features: supporting features that assist but are not the primary utility

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — EXTRACT VERIFIABLE CLAIMS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Derive 1–3 claims directly from your product understanding.

CLAIM PRINCIPLES:
- A claim must represent the product's TRUE utility — its reason to exist
- Preserve essential qualifiers that define HOW something works
  (e.g. "every 20 minutes", "linked to social account", "SHA-256", "using CPU cores in the browser")
- When the WORKFLOW is the feature, describe the full workflow — not just a fragment
- Avoid collapsing a differentiated product into a generic action

CLAIM PRIORITY — FILL ALL 3 SLOTS:
1. Primary product utility — the main thing users do here
2. Differentiating mechanism or secondary workflow — what makes this product work differently, or a second real user action
3. Supporting utility or data surface — a leaderboard, dashboard, stats page, or other observable feature

Always aim for exactly 3 claims.
After writing claim 1, actively look for a second and third distinct verifiable feature.
Return fewer than 3 ONLY when the product page contains fewer than 3 distinct, verifiable product features.
Do NOT stop at 1 or 2 because the first claim is strong.

INVALID CLAIMS (do not produce these):
✗ "The platform has a leaderboard" (navigation fragment, not utility)
✗ "Users can connect a wallet" (generic, not a product claim)
✗ "The platform offers a swap interface" (stripped of all mechanism)
✗ "Users can create tokens" (without any product-specific context)
✗ Roadmap / "coming soon" features
✗ Marketing language, team bios, tokenomics, infrastructure facts

VALID CLAIM SHAPE:
✓ Preserves the mechanism: "Users run SHA-256 mining in the browser using Web Workers — each hash becomes a lottery ticket for a prize pool drawn every 20 minutes"
✓ Preserves the workflow: "Anyone can create a token linked to a Twitter, GitHub, TikTok, or Twitch handle — a portion of all trading fees for that token is automatically routed to the linked creator"
✓ Preserves the outcome: "The platform displays a live leaderboard showing all tokens ranked by total fees earned for their linked social media creators"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FEATURE TYPES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Classify each claim as one of:
- UI_FEATURE      → generic interactive element (button, form, widget)
- DEX_SWAP        → token swap / AMM / on-chain trading action
- TOKEN_CREATION  → deploy or mint a token / NFT / on-chain asset
- API_FEATURE     → publicly accessible REST/JSON endpoint (no auth)
- BOT             → Telegram or Discord bot interaction
- CLI_TOOL        → command-line tool or script
- WALLET_FLOW     → any on-chain action requiring wallet connection (agent deployment, staking, competition entry, funding, creation flow via external link/bot)
- DATA_DASHBOARD  → leaderboard, stats table, charts, live data feed (read-only, no transaction)

CRITICAL classification rules:
- If the claim involves DEPLOYING, CREATING, LAUNCHING, FUNDING, or STAKING anything on-chain → WALLET_FLOW (even if done via Telegram bot or CLI)
- If the claim involves TRADING, SWAPPING, BUYING, SELLING on-chain → DEX_SWAP
- If the claim involves VIEWING stats, leaderboard, or data (no wallet needed) → DATA_DASHBOARD
- Do NOT classify claims as DATA_DASHBOARD just because they mention competition rankings — only if the data is publicly viewable without a transaction

Verification strategy per type:
- UI_FEATURE      → "ui+browser"
- DEX_SWAP        → "ui+rpc"
- TOKEN_CREATION  → "form+browser"
- API_FEATURE     → "api+fetch"
- BOT             → "message+bot"
- CLI_TOOL        → "terminal+cli"
- WALLET_FLOW     → "wallet+rpc"
- DATA_DASHBOARD  → "dashboard+browser"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SURFACE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The URL path where the feature lives.
- ONLY use paths visible in the page navigation or page content. NEVER invent paths.
- Use "/" if the feature is on the homepage.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PASS CONDITIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Describe what a tester OBSERVES if the claim is TRUE.
- Include visible evidence of the differentiating mechanism when relevant
- NEVER invent post-transaction states, invented outcomes, or made-up paths
- For wallet features: describe the modal/UI state that appears — not a completed transaction
- Good: "Navigate to / — a table ranking tokens by total fees with creator handles and claimed amounts is visible"
- Bad: "Navigate to /claim-fees and submit — fees appear in wallet" (invented path + invented outcome)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Return a single JSON object:

{
  "product_understanding": {
    "primary_utility": "...",
    "differentiating_mechanism": "...",
    "main_workflows": ["...", "..."],
    "secondary_features": ["...", "..."]
  },
  "claims": [
    {
      "claim": "Full description preserving the mechanism and workflow",
      "pass_condition": "What a tester observes if this claim is true",
      "feature_type": "<pick the correct type from the list above>",
      "surface": "/",
      "verification_strategy": "<matching strategy from the list above>"
    }
  ]
}

Return exactly 3 claims whenever 3 distinct verifiable features exist on the product.
Return fewer only if the product genuinely has fewer than 3 verifiable features.
If the product has no verifiable claims, return: { "product_understanding": {...}, "claims": [] }`;

// ── Extraction function ───────────────────────────────────────────────────────

/**
 * Two-step extraction in a single LLM call:
 *  1. Model builds a structured product understanding (primary utility, mechanism, workflows)
 *  2. Model derives 1–3 high-quality claims from that understanding
 *
 * Returns typed ExtractedClaim[] with feature_type, surface, verification_strategy.
 * Also logs the product understanding to console for observability.
 */
export async function extractClaimsFromText(
  projectName: string,
  websiteText: string,
  xText?: string,
  /** Optional project metadata to supplement minimal website content */
  projectMeta?: {
    symbol?: string | null;
    chain?: string | null;
    twitter?: string | null;
    description?: string | null;
  },
): Promise<ExtractedClaim[]> {
  const client = getClient();

  const sections: string[] = [
    `Project name: ${projectName}${projectMeta?.symbol ? ` (${projectMeta.symbol})` : ''}`,
  ];

  // When website content is minimal, supplement with available metadata
  if (websiteText.split('\n\n--- Navigation paths')[0].length < 250) {
    const meta: string[] = [];
    if (projectMeta?.chain)       meta.push(`Chain: ${projectMeta.chain.toUpperCase()}`);
    if (projectMeta?.twitter)     meta.push(`Twitter/X: ${projectMeta.twitter}`);
    if (projectMeta?.description) meta.push(`Description: ${projectMeta.description}`);
    if (meta.length > 0) {
      sections.push(`--- Project metadata (website content was too minimal to scrape) ---\n${meta.join('\n')}`);
    }
    sections.push(`--- Website content (minimal — site may block scrapers) ---\n${websiteText}`);
    // Instruct LLM to infer from name/symbol/context when content is sparse
    sections.push(
      `NOTE: Website returned very little content. Infer 2–3 realistic claims from the project ` +
      `name, symbol, and any metadata above. Use your knowledge of BSC/BNB chain DeFi patterns ` +
      `(token launches, staking, trading, cashback, leaderboards) to construct plausible claims ` +
      `that a legitimate project with this name would actually implement.`,
    );
  } else {
    sections.push(`--- Website content ---\n${websiteText}`);
  }

  if (xText && xText.length > 20) {
    sections.push(`--- Recent X (Twitter) posts ---\n${xText}`);
  }
  const userMessage = sections.join('\n\n');

  const response = await client.chat.completions.create({
    model:           'gpt-4.1',
    temperature:     0.1,
    max_tokens:      2_200,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userMessage },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '{}';

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return [];
  }

  // Log product understanding for observability
  const understanding = parsed.product_understanding as ProductUnderstanding | undefined;
  if (understanding) {
    console.log('[llm] Product understanding:');
    console.log('  Primary utility:           ', understanding.primary_utility);
    console.log('  Differentiating mechanism: ', understanding.differentiating_mechanism);
    console.log('  Main workflows:            ', understanding.main_workflows?.join(' | '));
  }

  // Extract and validate claims array
  const arr: unknown = Array.isArray(parsed.claims)
    ? parsed.claims
    : Object.values(parsed).find(Array.isArray);

  if (!Array.isArray(arr)) return [];

  const claims = (arr as Record<string, unknown>[])
    .filter(
      (item) =>
        typeof item?.claim          === 'string' && item.claim.trim().length > 10 &&
        typeof item?.pass_condition === 'string' && item.pass_condition.trim().length > 10,
    )
    .map((item) => {
      const featureType: FeatureType = VALID_FEATURE_TYPES.has(item.feature_type as FeatureType)
        ? (item.feature_type as FeatureType)
        : 'UI_FEATURE';

      const strategy: VerificationStrategy = VALID_STRATEGIES.has(item.verification_strategy as VerificationStrategy)
        ? (item.verification_strategy as VerificationStrategy)
        : 'ui+browser';

      return {
        claim:                 String(item.claim).trim(),
        pass_condition:        String(item.pass_condition).trim(),
        feature_type:          featureType,
        surface:               typeof item.surface === 'string' && item.surface.trim()
          ? item.surface.trim()
          : '/',
        verification_strategy: strategy,
      } satisfies ExtractedClaim;
    })
    .slice(0, 3);

  console.log(`[llm] Extracted ${claims.length} claim(s):`);
  claims.forEach((c, i) =>
    console.log(`  [${i + 1}] [${c.feature_type}] ${c.claim.slice(0, 80)}`),
  );

  return claims;
}
