-- Enable RLS on all tables (audit P4).
-- Service role (used by API routes) bypasses RLS automatically.
-- Anon/authenticated roles have no policies → deny by default if key leaks.

alter table projects           enable row level security;
alter table verification_runs  enable row level security;
alter table claims             enable row level security;
alter table agent_logs         enable row level security;
alter table evidence_items     enable row level security;
alter table agents             enable row level security;
