# LarpScan

**LarpScan** is an autonomous AI agent that verifies whether Web3 projects actually work as claimed. Paste a BNB Chain contract address and the agent browses the dApp, connects a wallet, tests every core feature, and returns a verdict — with video proof.

> Built for the [Four.meme AI Sprint Hackathon](https://dorahacks.io) on BNB Chain.
>
> Live: [larpscan.sh](https://larpscan.sh)

---

## What It Does

1. **Scrapes** the project's website and X/Twitter for product claims
2. **Extracts** 3 testable claims using GPT-4o (e.g. "Users can create a token", "Dashboard shows live stats")
3. **Launches a real browser** via Browserless.io with a mock wallet injected
4. **Executes** each claim using a ReAct agent loop — navigating, filling forms, clicking buttons, and watching for on-chain responses
5. **Records** the full session as an MP4 video with AI voice narration
6. **Returns** a verdict: `VERIFIED`, `UNTESTABLE`, or `LARP` — backed by video + on-chain evidence

---

## Tech Stack

| Layer | Tech |
|---|---|
| Framework | Next.js 15 (App Router, serverless) |
| Browser automation | Playwright + Browserless.io (residential proxy, video recording) |
| AI/LLM | OpenAI GPT-4o (planning, verdict), GPT-4o-mini (adaptive steps), TTS (narration) |
| Wallet | viem, mock EIP-1193 provider, EIP-6963 announcements, wagmi/AppKit priming |
| On-chain | Direct BSC RPC — bytecode, ERC-20 metadata, liquidity pair detection |
| Database | Supabase (PostgreSQL + Storage for video uploads) |
| Styling | Tailwind CSS, Framer Motion, horsestudiowebgl (WebGL background) |
| Deployment | Vercel (fan-out serverless, 300s function timeout) |

---

## Architecture

```
User enters CA
    │
    ▼
/api/project/discover      ← validate contract + enrich metadata (RPC + Moralis)
    │
    ▼
/api/verify/orchestrate    ← scrape website + X, extract 3 claims via GPT-4o
    │
    ▼ (fan-out — 3 parallel serverless calls)
/api/verify/claim          ← for each claim:
    │   1. analyzeWebsite() — Session 1: screenshot, page state, surface check
    │   2. recordInteraction() — Session 2: plan → execute → record
    │      ├── planWorkflow() — GPT-4o-mini plans steps
    │      ├── executeSteps() — ReAct loop: observe → decide → act
    │      ├── wallet mock injection (EIP-1193 + EIP-6963)
    │      ├── convertWebmToMp4() + mergeNarrationWithVideo()
    │      └── upload to Supabase Storage
    │   3. buildSignals() — aggregate evidence
    │   4. evaluateDeterministicVerdict() — rule-based fast path
    │   5. determineVerdict() — GPT-4o fallback with screenshot
    │
    ▼
Dashboard polls /api/verify/status
    └── displays verdict + video player per claim
```

---

## Agent Intelligence

The browser agent uses a **ReAct (Reason + Act) loop**:

- **Planning:** GPT-4o-mini generates an initial step sequence based on page analysis and claim type
- **Execution:** Steps run with full DOM observation — URL changes, modal detection, API call tracking, form signal detection
- **Adaptive decisions:** When the plan queue empties, GPT-4o-mini takes a screenshot and decides the next action with chain-of-thought reasoning
- **Claim type routing:** 8 claim types (`WALLET_FLOW`, `DATA_DASHBOARD`, `TOKEN_CREATION`, `API_FEATURE`, etc.) each get different execution strategies
- **Hard guards:** Observation claims (`DATA_DASHBOARD`, `UI_FEATURE`) have executor-level blocks preventing form fills or transactional clicks
- **Wallet stack detection:** Identifies wagmi/AppKit, RainbowKit, WalletConnect, Privy via DOM signals and adapts connection strategy

---

## Setup

### Prerequisites

- Node.js 20+
- A Supabase project (free tier works)
- Browserless.io account (Prototyping plan for video recording)
- OpenAI API key

### 1. Clone and install

```bash
git clone https://github.com/your-username/larpscan.git
cd larpscan
npm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
# Edit .env.local with your actual values
```

See [`.env.example`](.env.example) for all required variables.

### 3. Set up the database

Run [`supabase/schema.sql`](supabase/schema.sql) in your Supabase SQL editor to create the tables.

### 4. Run locally

```bash
npm run dev
# Open http://localhost:3000
```

> Local mode uses your machine's Playwright installation (no Browserless needed for basic testing). Video recording requires a Browserless token.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (server-side only) |
| `OPENAI_API_KEY` | Yes | OpenAI API key (GPT-4o + TTS) |
| `BROWSERLESS_TOKEN` | Yes* | Browserless.io token (*required for Vercel) |
| `NODEREAL_RPC` | Yes | BNB Chain RPC endpoint |
| `MORALIS_API_KEY` | No | Token metadata enrichment |
| `X_BEARER_TOKEN` | No | X/Twitter scraping |
| `INVESTIGATION_WALLET_PRIVATE_KEY` | No | Wallet for on-chain interactions |
| `ENABLE_VOICE_NARRATION` | No | `true` to add TTS to videos |
| `AGENT_VOICE` | No | TTS voice name (default: `onyx`) |

---

## Project Structure

```
larpscan/
├── app/
│   ├── api/
│   │   ├── project/discover/     ← contract validation + metadata
│   │   ├── verify/
│   │   │   ├── orchestrate/      ← claim extraction pipeline
│   │   │   ├── run/              ← dispatch fan-out
│   │   │   ├── claim/            ← single claim verification
│   │   │   └── status/           ← polling endpoint
│   │   └── runs/recent/          ← dashboard feed
│   ├── dashboard/                ← main UI
│   ├── docs/                     ← documentation page
│   └── home/                     ← landing page
├── components/                   ← React UI components
├── lib/
│   ├── browser-agent/            ← Playwright agent (executor, planner, wallet)
│   ├── wallet/                   ← Wallet mock, signer, policy, monitor
│   ├── verifier.ts               ← Orchestrates browser sessions + recording
│   ├── verification-graph.ts     ← Routes claims to correct strategy
│   ├── verdict-rules.ts          ← Deterministic verdict rules
│   ├── verdict.ts                ← GPT-4o verdict fallback
│   ├── llm.ts                    ← Claim extraction
│   ├── rpc.ts                    ← BNB Chain on-chain analysis
│   ├── scraper.ts                ← Website text extraction
│   └── tts.ts                    ← Voice narration generation
└── supabase/
    └── schema.sql                ← Database schema
```

---

## License

MIT — see [LICENSE](LICENSE)
