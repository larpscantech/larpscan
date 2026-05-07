import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { ok } from '@/lib/api-helpers';

// ── Merkle helpers ────────────────────────────────────────────────────────────
function sha256(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function buildMerkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return '0'.repeat(64);
  let level = leaves.map(l => sha256(l));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? a;
      next.push(sha256(a <= b ? a + b : b + a));
    }
    level = next;
  }
  return level[0];
}

// ── GET /api/agents/[id] ──────────────────────────────────────────────────────
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const { data: agent, error } = await supabase
      .from('agents')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // Runs for this agent
    const { data: runs } = await supabase
      .from('verification_runs')
      .select('id, status, created_at, project_id')
      .eq('agent_id', id)
      .order('created_at', { ascending: false })
      .limit(50);

    const runIds      = (runs ?? []).map(r => r.id as string);
    const projectIds  = [...new Set((runs ?? []).map(r => r.project_id as string))];

    // Project names map
    let projectMap: Record<string, string> = {};
    if (projectIds.length > 0) {
      const { data: projects } = await supabase
        .from('projects')
        .select('id, name')
        .in('id', projectIds);
      projectMap = Object.fromEntries((projects ?? []).map(p => [p.id as string, p.name as string]));
    }

    // runId → projectId map
    const runProjectMap = Object.fromEntries(
      (runs ?? []).map(r => [r.id as string, r.project_id as string])
    );

    // Terminal claims for this agent's runs
    type ClaimRow = { id: string; claim: string; status: string; created_at: string; verification_run_id: string | null };
    let terminalClaims: ClaimRow[] = [];
    let claimCounts = { total: 0, verified: 0, larp: 0, untestable: 0 };

    if (runIds.length > 0) {
      const { data: claims } = await supabase
        .from('claims')
        .select('id, claim, status, created_at, verification_run_id')
        .in('verification_run_id', runIds)
        .in('status', ['verified', 'larp', 'untestable'])
        .order('created_at', { ascending: false })
        .limit(200)
        .returns<ClaimRow[]>();

      terminalClaims = claims ?? [];

      for (const c of terminalClaims) {
        claimCounts.total++;
        if (c.status === 'verified')   claimCounts.verified++;
        if (c.status === 'larp')       claimCounts.larp++;
        if (c.status === 'untestable') claimCounts.untestable++;
      }
    }

    // Build Merkle root — sort by id for determinism
    const sorted = [...terminalClaims].sort((a, b) => a.id.localeCompare(b.id));
    const leaves = sorted.map(c => `${c.id}|${c.claim}|${c.status}`);
    const memoryRoot = `0x${buildMerkleRoot(leaves)}`;

    // Memory entries for display
    const memoryEntries = terminalClaims.slice(0, 20).map(c => ({
      id:          c.id,
      claim:       c.claim,
      verdict:     c.status,
      projectName: projectMap[runProjectMap[c.verification_run_id ?? ''] ?? ''] ?? 'Unknown',
      created_at:  c.created_at,
    }));

    return NextResponse.json({
      agent,
      stats: {
        totalRuns: (runs ?? []).length,
        ...claimCounts,
        passRate: claimCounts.total > 0
          ? Math.round((claimCounts.verified / claimCounts.total) * 100)
          : null,
      },
      recentRuns: (runs ?? []).slice(0, 5),
      memory: {
        root:    memoryRoot,
        count:   terminalClaims.length,
        entries: memoryEntries,
      },
    });
  } catch (e) {
    console.error('[agents/id] GET error:', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── PATCH /api/agents/[id] ────────────────────────────────────────────────────
interface EditBody {
  ownerAddress:  string;
  name?:         string;
  description?:  string;
  systemPrompt?: string;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json()) as EditBody;
    const { ownerAddress, name, description, systemPrompt } = body;

    if (!ownerAddress) {
      return new Response(JSON.stringify({ error: 'ownerAddress required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    const { data: existing, error: fetchErr } = await supabase
      .from('agents')
      .select('id, owner_address, personality')
      .eq('id', id)
      .single();

    if (fetchErr || !existing) {
      return new Response(JSON.stringify({ error: 'Agent not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (existing.owner_address !== ownerAddress.toLowerCase()) {
      return new Response(JSON.stringify({ error: 'Not your agent' }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      });
    }

    const updates: Record<string, string> = {};
    if (name         !== undefined) updates.name        = name;
    if (description  !== undefined) updates.description = description;
    if (systemPrompt !== undefined && existing.personality === 'custom') {
      updates.system_prompt = systemPrompt;
    }

    if (Object.keys(updates).length === 0) {
      return new Response(JSON.stringify({ error: 'No valid fields to update' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    const { error: updateErr } = await supabase
      .from('agents')
      .update(updates)
      .eq('id', id);

    if (updateErr) {
      console.error('[agents/edit] update error:', updateErr.message);
      return new Response(JSON.stringify({ error: updateErr.message }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }

    return ok({ id });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unexpected error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
