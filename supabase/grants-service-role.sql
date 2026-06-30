-- Run once in Supabase SQL Editor (Database → SQL → New query)
-- Fixes: permission denied for table projects (42501) with service_role REST client

GRANT USAGE ON SCHEMA public TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.projects TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.verification_runs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.claims TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_logs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.evidence_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agents TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
