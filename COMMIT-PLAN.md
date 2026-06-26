# Fresh history plan — larpscantech/larpscan

**Status:** Plan only — do **not** run commits until reviewed.  
**Remote:** https://github.com/larpscantech/larpscan  
**Goal:** Replace old history with a clean Solana-only tree. No BNB / BSC / legacy agent wording in commit messages.

---

## Before you start

1. Confirm `.env.local` is **not** staged (gitignored).
2. Fix remaining legacy strings in code (include in commits below):
   - `supabase/schema.sql` → `agents.chain` default `'bsc'` → `'solana'` (or drop `agents` table if unused)
   - `lib/wallet/signer.ts` → rename `bscScanTxUrl` → `solScanTxUrl` (alias ok)
   - `components/wallet-provider.tsx` / `connect-wallet-button.tsx` → remove BAP-578 comments
3. Run `npm run build` after all commits.

---

## Reset history (run once, when ready)

```bash
cd /path/to/larpscan

# Save current work — already in working tree
git checkout --orphan fresh-main

# After all commits below:
# git branch -D main          # optional: delete old local main
# git branch -m main          # rename fresh-main → main
# git push -u origin main --force   # ⚠️ rewrites GitHub history
```

---

## Commit sequence (12 commits)

Apply in order. Each block = `git add …` then `git commit -m "…"`.

---

### Commit 1 — Remove legacy agent UI and APIs

```
remove legacy agent mint, leaderboard, and wallet-auth stack
```

**Files:**
```
app/agent/mint/page.tsx                    (delete)
app/agents/page.tsx                        (delete)
app/agents/[id]/page.tsx                   (delete)
app/leaderboard/page.tsx                   (delete)
app/api/agents/route.ts                    (delete)
app/api/agents/[id]/route.ts               (delete)
app/api/agents/leaderboard/route.ts        (delete)
app/api/agent/record/route.ts              (delete)
lib/nfa-contract.ts                        (delete)
lib/verify-mint-tx.ts                      (delete)
lib/wagmi-config.ts                        (delete)
lib/wallet-auth.ts                         (delete)
test-agent-mint.mjs                        (delete)
components/connect-wallet-button.tsx
components/wallet-provider.tsx
components/navbar.tsx
```

---

### Commit 2 — Add Solana core library

```
feat: add Solana RPC helpers for mint validation and token analysis
```

**Files:**
```
lib/solana.ts                              (new)
lib/rpc.ts
lib/utils.ts
lib/types.ts
lib/db-types.ts
```

---

### Commit 3 — Rewrite project discovery for Solana

```
feat: discover projects on Solana via pump.fun, DexScreener, and Helius
```

**Files:**
```
app/api/project/discover/route.ts
```

---

### Commit 4 — Migrate investigation wallet to Solana

```
feat: migrate server investigation wallet to Solana keypair and lamports
```

**Files:**
```
lib/wallet/client.ts
lib/wallet/signer.ts
lib/wallet/monitor.ts
lib/wallet/policy.ts
lib/wallet/request-classifier.ts
lib/wallet/snapshots.ts
lib/wallet/tx-confirm.ts
```

---

### Commit 5 — Phantom browser mock

```
feat: replace EVM wallet mock with Phantom connect flow in browser agent
```

**Files:**
```
lib/browser-agent/wallet-connect-flow.ts
lib/browser-agent/wallet-reconnect.ts
lib/browser-agent/constants.ts
```

---

### Commit 6 — Browser agent Solana execution

```
refactor: align browser executor and planner with Solana wallet flows
```

**Files:**
```
lib/browser-agent/executor.ts
lib/browser-agent/planner.ts
lib/browser-agent/page-analysis.ts
lib/browser-agent/evidence.ts
```

---

### Commit 7 — Verifier and verdict pipeline

```
refactor: update verifier and verdict rules for Solana transaction evidence
```

**Files:**
```
lib/verifier.ts
lib/verdict.ts
lib/verdict-rules.ts
lib/verdict-signals.ts
lib/llm.ts
```

---

### Commit 8 — Verify API routes

```
feat: validate Solana mint addresses in verify and orchestrate routes
```

**Files:**
```
app/api/verify/active/route.ts
app/api/verify/orchestrate/route.ts
app/api/verify/claim/route.ts
app/api/verify/start/route.ts
components/audit-claim-card.tsx
components/project-identity-bar.tsx
```

---

### Commit 9 — UI and copy (Solana / CA)

```
feat: update dashboard, docs, and home for Solana CA-first copy
```

**Files:**
```
app/dashboard/page.tsx
app/docs/page.tsx
app/home/page.tsx
app/layout.tsx
components/recent-verifications-table.tsx
components/navbar.tsx                       (if not fully in commit 1)
```

---

### Commit 10 — Dependencies and env

```
chore: replace wagmi/viem with Solana SDK and update env template
```

**Files:**
```
package.json
package-lock.json
.env.example
README.md
```

---

### Commit 11 — Database schema

```
chore: set default chain to solana in Supabase schema
```

**Files:**
```
supabase/schema.sql
supabase/migrations/001_add_agents_table.sql
supabase/migrations/002_add_agent_id_to_runs.sql
```

**Include in this commit:** fix `agents.chain default 'bsc'` → `'solana'` and scrub BAP-578 comments in migration files.

---

### Commit 12 — Tests and docs

```
docs: add product summary; update verification test scripts for Solana
```

**Files:**
```
LARPSCAN-SUMMARY.md                        (new)
test-verify.mjs
test-stability.mjs
```

---

## Initial commit alternative (single squash)

If you prefer **one** root commit instead of 12:

```
feat: LarpScan — Solana verification agent with browser evidence

Autonomous browser agent for projects on Solana. Paste a CA, discover
via pump.fun/DexScreener, extract claims, verify in Playwright with
Phantom mock, return verdicts with screenshots and Solscan links.
```

Then `git add -A` (excluding `.env.local`) once.

---

## After push checklist

- [ ] GitHub repo shows single clean history (or 12 logical commits)
- [ ] No commit message contains: BNB, BSC, BAP, wagmi, four.meme, FLAP
- [ ] `npm run build` passes
- [ ] Vercel env vars updated (Solana RPC, Helius, Supabase, OpenAI, Browserless)
- [ ] Force-push only when team agrees (`git push --force origin main`)

---

## Commit message rules (this plan)

| Avoid | Use instead |
|-------|-------------|
| BNB / BSC | Solana / SOL |
| contract address | CA / mint |
| BAP-578 / NFA agent | (omit — feature removed) |
| wagmi / MetaMask migration | Phantom / Solana wallet |
| four.meme / FLAP | pump.fun / DexScreener |
