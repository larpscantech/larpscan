/**
 * scripts/test-website-e2e.ts
 *
 * End-to-end test that drives the ChainVerify backend API directly
 * (same flow the frontend triggers) and reports on consistency.
 *
 * Run: npx tsx scripts/test-website-e2e.ts
 */

import * as path from 'path';
import * as fs   from 'fs';

// ─── Load env ────────────────────────────────────────────────────────────────
const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) {
      const k = m[1].trim();
      if (!process.env[k]) process.env[k] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

const BASE         = process.env.NEXT_DEV_URL ?? 'http://localhost:3000';
const CONTRACT     = '0x1646980a0e0ebea85db014807205aa4d9bf87777';
const POLL_MS      = 4_000;
const MAX_WAIT_MS  = 360_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function api<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method:  body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body:    body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

function dim(s: string) { return `\x1b[2m${s}\x1b[0m`; }
function green(s: string) { return `\x1b[32m${s}\x1b[0m`; }
function red(s: string) { return `\x1b[31m${s}\x1b[0m`; }
function bold(s: string) { return `\x1b[1m${s}\x1b[0m`; }
function cyan(s: string) { return `\x1b[36m${s}\x1b[0m`; }

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(bold('\n🔬 ChainVerify API End-to-End Test'));
  console.log(`   Server:   ${BASE}`);
  console.log(`   Contract: ${CONTRACT}\n`);

  // ── 1. Discover project ──────────────────────────────────────────────────
  console.log(bold('[1] Project discovery...'));
  const discoverRes = await api<{ project?: { id: string; name?: string; website?: string; twitter?: string } }>(
    '/api/project/discover',
    { contractAddress: CONTRACT },
  );
  const project = discoverRes.project;
  if (!project?.id) throw new Error('Project discovery failed — no project ID returned');
  console.log(`    ✅ Project: ${project.name ?? '(unnamed)'} (${project.id.slice(0, 8)}...)`);
  console.log(`    Website:  ${project.website ?? 'none'}`);
  console.log(`    Twitter:  ${project.twitter ?? 'none'}`);

  // ── 2. Start verification run FIRST (so claims get linked to it) ─────────
  console.log(bold('\n[2] Creating verification run...'));
  const startRes = await api<{ runId?: string }>(
    '/api/verify/start',
    { projectId: project.id },
  );
  const runId = startRes.runId;
  if (!runId) throw new Error('No runId returned from /api/verify/start');
  console.log(`    ✅ Run ID: ${runId}`);

  // ── 3. Scrape website + extract claims (linked to runId) ─────────────────
  console.log(bold('\n[3] Extracting claims...'));
  let websiteText = '';
  try {
    const textRes = await api<{ text?: string }>(
      '/api/project/extract-text',
      { website: project.website },
    );
    websiteText = textRes.text ?? '';
    console.log(`    Scraped ${websiteText.length} chars from ${project.website}`);
  } catch (e) {
    console.warn(`    ⚠️  Text extraction failed: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
  }

  // Pass runId so claims get verification_run_id set correctly
  const claimsRes = await api<{ claims?: Array<{ id: string; claim: string; feature_type?: string; surface?: string }> }>(
    '/api/claims/extract',
    { projectId: project.id, runId, websiteText },
  );
  const claims = claimsRes.claims ?? [];
  console.log(`    ✅ ${claims.length} claim(s) extracted:`);
  claims.forEach((c, i) => {
    console.log(`    ${i + 1}. [${c.feature_type ?? '?'}] "${c.claim.slice(0, 70)}"`);
    console.log(dim(`       surface: ${c.surface ?? '/'}`));
  });
  console.log(`    ✅ Run ID: ${runId}`);

  if (!claims.length) {
    console.warn(red('    ⚠️  No claims extracted — aborting'));
    process.exit(1);
  }

  // ── 4. Trigger verification engine ───────────────────────────────────────
  console.log(bold('\n[4] Triggering verification engine...'));
  // Fire and forget — verify/run is async (responds 200 when done)
  const verifyPromise = api<unknown>('/api/verify/run', { runId, projectId: project.id }).catch((e) => {
    console.log(dim(`    (run endpoint: ${e instanceof Error ? e.message.slice(0, 80) : e})`));
  });

  // ── 5. Poll status until complete ────────────────────────────────────────
  console.log(bold('\n[5] Polling verification status...\n'));
  const start    = Date.now();
  let lastLogIdx = 0;
  let done       = false;

  while (!done && Date.now() - start < MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));

    let status: {
      run?: { status?: string };
      claims?: Array<{
        id: string; claim: string; status: string;
        evidence_items?: Array<{
          data?: {
            verdict?: string; reasoning?: string; confidence?: string;
            transactionHash?: string; transactionExplorerUrl?: string;
            matchedRule?: string;
          };
        }>;
      }>;
      logs?: Array<{ message: string }>;
    };

    try {
      status = await api(`/api/verify/status?runId=${runId}`);
    } catch {
      continue;
    }

    // Print new logs
    const logs = status.logs ?? [];
    for (const log of logs.slice(lastLogIdx)) {
      const msg = log.message;
      const isVerdict  = /verdict.*→|verified|larp|untestable/i.test(msg);
      const isTx       = /on.chain|bscscan|0x[0-9a-f]{60}/i.test(msg);
      const isError    = /error|fail/i.test(msg);
      const prefix     = isVerdict ? '  📋 ' : isTx ? '  🔗 ' : isError ? '  ❌ ' : '  → ';
      console.log(prefix + (isVerdict ? bold(msg) : isTx ? cyan(msg) : msg));
    }
    lastLogIdx = logs.length;

    const runStatus = status.run?.status ?? 'unknown';

    if (runStatus === 'complete' || runStatus === 'failed') {
      done = true;
      const elapsed = Math.round((Date.now() - start) / 1000);

      console.log(`\n${'─'.repeat(60)}`);
      console.log(bold(`\n✅ Run ${runStatus.toUpperCase()} in ${elapsed}s\n`));

      // Results table
      for (const claim of (status.claims ?? [])) {
        const ev = claim.evidence_items?.[0]?.data;
        const verdict = ev?.verdict ?? claim.status;
        const color = verdict === 'verified' ? green : verdict === 'larp' ? red : dim;

        console.log(bold(`  Claim: "${claim.claim.slice(0, 70)}"`));
        console.log(`  Status:    ${color(verdict.toUpperCase())}`);
        if (ev?.confidence)  console.log(`  Confidence: ${ev.confidence}`);
        if (ev?.matchedRule) console.log(`  Rule:       ${cyan(ev.matchedRule)}`);
        if (ev?.reasoning)   console.log(`  Reasoning:  ${ev.reasoning.slice(0, 150)}`);

        if (ev?.transactionHash) {
          console.log(green(`\n  🔗 ON-CHAIN TRANSACTION SUBMITTED`));
          console.log(cyan(`     Hash: ${ev.transactionHash}`));
          console.log(cyan(`     BscScan: ${ev.transactionExplorerUrl}`));
        }
        console.log('');
      }
    } else {
      const elapsed = Math.round((Date.now() - start) / 1000);
      process.stdout.write(dim(`  [${elapsed}s] ${runStatus}... `));
    }
  }

  if (!done) {
    console.log(red('\n⚠️  Timed out'));
  }

  await verifyPromise;
}

main().catch((e) => {
  console.error(red('\n❌ Test error: ') + e.message);
  process.exit(1);
});
