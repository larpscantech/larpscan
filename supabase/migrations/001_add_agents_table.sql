-- Migration 001 — Add agents table
-- Run this in Supabase SQL Editor (Database → SQL Editor → New query)
-- Safe to run on an existing database — uses IF NOT EXISTS throughout.

create table if not exists agents (
  id             uuid        default gen_random_uuid() primary key,
  owner_address  text        not null,
  token_id       text,
  tx_hash        text,
  name           text        not null,
  description    text,
  image          text,
  personality    text        not null default 'larpscan'
                             check (personality in ('larpscan', 'custom')),
  system_prompt  text,
  chain          text        not null default 'solana',
  created_at     timestamptz default now()
);

create index if not exists idx_agents_owner on agents(owner_address);

alter table agents disable row level security;
