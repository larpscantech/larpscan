-- ─────────────────────────────────────────────────────────────────────────────
-- ChainVerify — Supabase schema
-- Run this in the Supabase SQL editor (Database → SQL Editor → New query)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Drop all tables (cascade removes FK dependencies) ─────────────────────────
drop table if exists evidence_items    cascade;
drop table if exists agent_logs        cascade;
drop table if exists claims            cascade;
drop table if exists verification_runs cascade;
drop table if exists projects          cascade;

-- ── Enable UUID generation ────────────────────────────────────────────────────
create extension if not exists "pgcrypto";

-- ── projects ──────────────────────────────────────────────────────────────────
-- One row per unique contract address.
create table if not exists projects (
  id               uuid        default gen_random_uuid() primary key,
  contract_address text        not null unique,
  name             text        not null,
  symbol           text        not null,
  website          text,
  twitter          text,
  logo_url         text,
  chain            text        not null default 'bsc',
  created_at       timestamptz default now()
);

-- ── verification_runs ─────────────────────────────────────────────────────────
-- One row per scan request. Tracks pipeline progress.
create table if not exists verification_runs (
  id               uuid        default gen_random_uuid() primary key,
  project_id       uuid        not null references projects(id) on delete cascade,
  status           text        not null default 'pending'
                               check (status in (
                                 'pending','extracting','analyzing',
                                 'verifying','complete','failed'
                               )),
  claims_extracted integer     not null default 0,
  created_at       timestamptz default now()
);

-- ── claims ────────────────────────────────────────────────────────────────────
-- Product claims extracted from the project website.
-- verification_run_id is nullable because claims may be extracted before a run
-- is formally started (e.g. in a pre-scan preview flow).
create table if not exists claims (
  id                    uuid        default gen_random_uuid() primary key,
  project_id            uuid        not null references projects(id) on delete cascade,
  verification_run_id   uuid        references verification_runs(id) on delete cascade,
  claim                 text        not null,
  pass_condition        text        not null,
  feature_type          text        check (feature_type in (
                                      'UI_FEATURE','DEX_SWAP','TOKEN_CREATION',
                                      'API_FEATURE','BOT','CLI_TOOL',
                                      'WALLET_FLOW','DATA_DASHBOARD'
                                    )),
  surface               text,       -- URL path where the feature lives, e.g. /swap
  verification_strategy text        check (verification_strategy in (
                                      'ui+browser','ui+rpc','form+browser',
                                      'api+fetch','message+bot','terminal+cli',
                                      'wallet+rpc','dashboard+browser'
                                    )),
  status                text        not null default 'pending'
                                    check (status in (
                                      'pending','checking','verified',
                                      'larp','untestable','failed'
                                    )),
  created_at            timestamptz default now()
);

-- ── Migration helper (run against existing DB instead of full schema reset) ──
-- alter table claims add column if not exists feature_type          text;
-- alter table claims add column if not exists surface               text;
-- alter table claims add column if not exists verification_strategy text;

-- ── agent_logs ────────────────────────────────────────────────────────────────
-- Streaming log messages emitted during a verification run.
create table if not exists agent_logs (
  id                  uuid        default gen_random_uuid() primary key,
  verification_run_id uuid        not null references verification_runs(id) on delete cascade,
  message             text        not null,
  created_at          timestamptz default now()
);

-- ── evidence_items ────────────────────────────────────────────────────────────
-- Artifacts collected while verifying a claim (screenshots, HTTP responses, etc.)
create table if not exists evidence_items (
  id         uuid        default gen_random_uuid() primary key,
  claim_id   uuid        not null references claims(id) on delete cascade,
  type       text        not null,   -- e.g. 'http_response', 'screenshot', 'log'
  data       jsonb,
  created_at timestamptz default now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
create index if not exists idx_projects_contract
  on projects(contract_address);

create index if not exists idx_runs_project
  on verification_runs(project_id);

create index if not exists idx_runs_status
  on verification_runs(status);

create index if not exists idx_claims_run
  on claims(verification_run_id);

create index if not exists idx_claims_project
  on claims(project_id);

create index if not exists idx_logs_run
  on agent_logs(verification_run_id);

create index if not exists idx_logs_created
  on agent_logs(verification_run_id, created_at);

create index if not exists idx_evidence_claim
  on evidence_items(claim_id);

-- ── Row-level security ────────────────────────────────────────────────────────
-- All reads/writes go through the service role key in API routes,
-- so RLS is disabled for now. Enable and tighten once a user auth layer is added.
alter table projects          disable row level security;
alter table verification_runs disable row level security;
alter table claims            disable row level security;
alter table agent_logs        disable row level security;
alter table evidence_items    disable row level security;
