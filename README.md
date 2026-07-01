# LarpScan

**LarpScan** is an autonomous AI agent that verifies whether Web3 projects actually work as claimed. Paste a **Solana token mint address** and the agent browses the dApp, connects a Phantom wallet, tests every core feature, and returns a verdict — with video proof.

> Live: [larpscan.sh](https://larpscan.sh)

---

## What It Does

1. **Scrapes** the project's website and X/Twitter for product claims
2. **Extracts** 3 testable claims using GPT-4o
3. **Launches a real browser** via Browserless.io with a Phantom wallet mock injected
4. **Executes** each claim using a ReAct agent loop
5. **Records** the full session as an MP4 video with AI voice narration
6. **Returns** a verdict: `VERIFIED`, `UNTESTABLE`, or `LARP` — backed by video + on-chain evidence

---

## Tech Stack

| Layer | Tech |
|---|---|
| Framework | Next.js 15 (App Router, serverless) |
| Browser automation | Playwright + Browserless.io |
| AI/LLM | OpenAI GPT-4o + TTS |
| Chain | Solana mainnet — SPL mints, pump.fun + DexScreener discovery |
| Wallet | Phantom mock + server investigation keypair |
| Database | Supabase (PostgreSQL + video storage) |
| Deployment | Vercel |

---

## Architecture

```
User enters Solana mint
    │
    ▼
/api/project/discover      ← validate SPL mint + enrich (pump.fun, DexScreener, Helius)
    │
    ▼
/api/verify/orchestrate    ← scrape website + X, extract 3 claims
    │
    ▼ (fan-out)
/api/verify/claim          ← browser agent + verdict per claim
    │
    ▼
Dashboard polls /api/verify/status
```

---

## Setup

```bash
git clone https://github.com/larpscantech/larpscan.git
cd larpscan
npm install
cp .env.example .env.local
npm run dev
```

Run `supabase/schema.sql` in your Supabase SQL editor.

---

## Environment Variables

| Variable | Required | Cost |
|---|---|---|
| `OPENAI_API_KEY` | Yes | Paid — GPT-4o + TTS usage |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Free tier works |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Free |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Free |
| `BROWSERLESS_TOKEN` | Yes on Vercel | Paid plan for video recording |
| `SOLANA_RPC_URL` | Yes | Free public RPC works; Helius free tier recommended |
| `INVESTIGATION_WALLET_PRIVATE_KEY` | No | Free — fund wallet with ~0.1 SOL for txs |
| `HELIUS_API_KEY` | No | Free tier — richer token metadata |
| `X_BEARER_TOKEN` | No | Optional X scraping |
| `INTERNAL_API_KEY` | Yes in prod | Free |
| `ENABLE_VOICE_NARRATION` | No | Set to `true` to overlay AI voice commentary on verification videos |
| `AGENT_VOICE` | No | OpenAI TTS voice for narration — `onyx` (default), `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `nova`, `sage`, `shimmer` |

**Free to develop locally:** Supabase free tier + public Solana RPC + local Playwright (no Browserless).

**Costs real money when scanning on mainnet:** investigation wallet needs SOL for transaction fees; OpenAI API usage per scan.

---

## Token discovery (Solana)

| Source | Purpose |
|---|---|
| **pump.fun API** | Meme launchpad metadata (website, Twitter, image) |
| **DexScreener** | DEX pools across Raydium/Orca/Meteora/pump |
| **GeckoTerminal / CoinGecko** | Graduated tokens |
| **Helius DAS** (optional) | Metaplex on-chain metadata |

---

## License

MIT — see [LICENSE](LICENSE)
