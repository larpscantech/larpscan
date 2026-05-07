-- ── 002_add_agent_id_to_runs ─────────────────────────────────────────────────
-- Links verification runs to the BAP-578 agent that performed them.
-- Run in Supabase SQL Editor → New query

alter table verification_runs
  add column if not exists agent_id uuid references agents(id);

create index if not exists idx_runs_agent
  on verification_runs(agent_id);
