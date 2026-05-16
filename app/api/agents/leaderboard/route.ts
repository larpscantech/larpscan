import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const revalidate = 60; // cache for 60s

export interface LeaderboardEntry {
  id:            string;
  name:          string;
  image:         string | null;
  personality:   string;
  owner_address: string;
  token_id:      string | null;
  created_at:    string;
  totalRuns:     number;
  totalClaims:   number;
  verified:      number;
  larp:          number;
  untestable:    number;
  passRate:      number | null;
  /** Composite score used for ranking: verified * ln(totalClaims + 1) */
  score:         number;
}

export async function GET() {
  try {
    // Fetch all agents that have at least one completed run
    const { data: agents, error } = await supabase
      .from('agents')
      .select('id, name, image, personality, owner_address, token_id, created_at')
      .order('created_at', { ascending: true });

    if (error || !agents?.length) {
      return NextResponse.json({ leaderboard: [] });
    }

    // Fetch all completed runs with agent_id set
    const { data: runs } = await supabase
      .from('verification_runs')
      .select('id, agent_id')
      .eq('status', 'complete')
      .not('agent_id', 'is', null);

    if (!runs?.length) {
      return NextResponse.json({ leaderboard: [] });
    }

    // Group run IDs per agent
    const agentRunMap = new Map<string, string[]>();
    for (const run of runs) {
      const aid = run.agent_id as string;
      if (!agentRunMap.has(aid)) agentRunMap.set(aid, []);
      agentRunMap.get(aid)!.push(run.id as string);
    }

    // Collect all run IDs so we can batch-fetch claims
    const allRunIds = runs.map(r => r.id as string);
    const { data: claims } = await supabase
      .from('claims')
      .select('verification_run_id, status')
      .in('verification_run_id', allRunIds)
      .in('status', ['verified', 'larp', 'untestable']);

    // Build a map: runId → { verified, larp, untestable }
    type ClaimBucket = { verified: number; larp: number; untestable: number };
    const runClaimMap = new Map<string, ClaimBucket>();
    for (const c of claims ?? []) {
      const rid = c.verification_run_id as string;
      if (!runClaimMap.has(rid)) runClaimMap.set(rid, { verified: 0, larp: 0, untestable: 0 });
      const bucket = runClaimMap.get(rid)!;
      if (c.status === 'verified')   bucket.verified++;
      if (c.status === 'larp')       bucket.larp++;
      if (c.status === 'untestable') bucket.untestable++;
    }

    // Compute per-agent stats
    const entries: LeaderboardEntry[] = [];

    for (const agent of agents) {
      const runIds = agentRunMap.get(agent.id) ?? [];
      if (!runIds.length) continue;

      let verified = 0, larp = 0, untestable = 0;
      for (const rid of runIds) {
        const b = runClaimMap.get(rid);
        if (!b) continue;
        verified   += b.verified;
        larp       += b.larp;
        untestable += b.untestable;
      }

      const totalClaims = verified + larp + untestable;
      const passRate    = totalClaims > 0
        ? Math.round((verified / totalClaims) * 100)
        : null;

      // Score: reward agents that have done more work AND have a high pass rate.
      // log-scaling total claims prevents bots from spamming low-quality scans to top the board.
      const score = passRate !== null
        ? (verified * Math.log(totalClaims + 1))
        : 0;

      entries.push({
        id:            agent.id,
        name:          agent.name,
        image:         agent.image,
        personality:   agent.personality,
        owner_address: agent.owner_address,
        token_id:      agent.token_id,
        created_at:    agent.created_at,
        totalRuns:     runIds.length,
        totalClaims,
        verified,
        larp,
        untestable,
        passRate,
        score,
      });
    }

    // Sort: highest score first, then pass rate, then total verified
    entries.sort((a, b) => {
      if (b.score !== a.score)       return b.score - a.score;
      if ((b.passRate ?? 0) !== (a.passRate ?? 0)) return (b.passRate ?? 0) - (a.passRate ?? 0);
      return b.verified - a.verified;
    });

    return NextResponse.json({ leaderboard: entries });
  } catch (e) {
    console.error('[leaderboard] error:', e);
    return NextResponse.json({ leaderboard: [] });
  }
}
