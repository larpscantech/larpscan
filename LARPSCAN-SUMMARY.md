# What is LarpScan?

**LarpScan** is an autonomous verification platform for **projects on Solana**. It checks whether a product actually does what its website and social posts claim — not by reading marketing copy, but by running a real browser, interacting with the live app, and collecting evidence.

Live site: [larpscan.sh](https://larpscan.sh)

---

## The problem

Many projects on Solana promise features that do not exist, are broken, or only work under ideal conditions. Manual due diligence is slow and inconsistent. LarpScan automates that process with a browser agent, structured evidence, and deterministic verdicts.

---

## How it works

1. **Input** — Paste a Solana SPL mint address (or a project website URL).
2. **Discovery** — Resolve token name, symbol, website, and social links via pump.fun, DexScreener, GeckoTerminal, CoinGecko, and optionally Helius.
3. **Claim extraction** — Scrape the site and X/Twitter, then use an LLM to turn marketing language into testable claims with pass conditions.
4. **Browser verification** — A Playwright agent (Browserless in production, local Playwright in dev) navigates the live product, connects via a Phantom wallet mock, and executes each claim.
5. **Verdict** — Each claim gets a label backed by screenshots, logs, and optional on-chain proof (Solana tx signatures + Solscan links).
6. **Dashboard** — Results are stored in Supabase and shown with QA scores, evidence cards, and run history.

```
Mint or URL → discover → extract claims → verify each claim → verdict + evidence
```

---

## Verdicts

| Verdict | Meaning |
|---------|---------|
| **VERIFIED** | Observed behavior matches the claim with supporting evidence. |
| **LARP / FAILED** | Claimed functionality is missing, broken, or contradicted by what was observed. |
| **UNTESTABLE** | The surface looks real but is blocked (login, captcha, insufficient funds, etc.). |

---

## Solana-specific design

LarpScan is built for **Solana mainnet**:

- Mint validation and SPL metadata via RPC (Helius recommended)
- Token discovery through pump.fun and DEX aggregators
- Server-side **investigation wallet** for signing when sites require wallet interaction
- **Phantom mock** injected into the browser for wallet-connect flows
- SOL spend caps per verification run

---

## Tech stack (short)

| Layer | Technology |
|-------|------------|
| App | Next.js 15 (App Router) |
| Automation | Playwright + Browserless |
| AI | OpenAI GPT-4o (claims, planning, verdicts) |
| Chain | Solana mainnet |
| Database | Supabase (PostgreSQL) |
| Deploy | Vercel |

---

## What LarpScan is not

- Not a price predictor or trading bot
- Not a mint scanner for rug-pull math alone — it tests **product claims** on Solana projects
- Not a replacement for full security audits (on-chain program review, team KYC, etc.)

---

## One-line summary

**LarpScan is a browser agent for projects on Solana that turns “does this product actually work?” into reproducible evidence and a clear verdict.**
