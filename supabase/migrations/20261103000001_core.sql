-- CONVOSAGE AI — core schema (Production Deployment Blueprint v1.0, 03 Nov 2026)
-- All application tables live in schema "app", which is NOT exposed through the Supabase REST API.
-- Access happens only through the authenticated API edge function, which enforces workspace scoping.
-- RLS is enabled on every table with no policies (default deny) as defence in depth.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;
create schema if not exists app;
revoke all on schema app from public;

-- ---------------------------------------------------------------- identity & tenancy
create table app.users (
  id uuid primary key,                          -- = auth.users.id (Supabase Auth subject)
  phone text,
  display_name text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table app.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  region text not null default 'ap-south-1',
  retention_days int not null default 180 check (retention_days between 1 and 3650),
  keep_raw_media boolean not null default false,
  policy jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table app.memberships (
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  user_id uuid not null references app.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','facilitator','member')),
  status text not null default 'active' check (status in ('active','invited','removed')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index on app.memberships(user_id);

-- ---------------------------------------------------------------- programmes & context
create table app.programmes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  title text not null check (length(title) between 1 and 200),
  description text,
  sharing_policy text not null default 'private' check (sharing_policy in ('private','workspace')),
  created_by uuid references app.users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create index on app.programmes(workspace_id);

-- Versioned context profile. Each fact carries provenance: source = 'user' | 'ai'.
create table app.context_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  programme_id uuid not null references app.programmes(id) on delete cascade,
  version int not null,
  content jsonb not null,
  created_by uuid references app.users(id),
  created_at timestamptz not null default now(),
  unique (programme_id, version)
);

-- ---------------------------------------------------------------- sessions (server-authoritative state)
create table app.sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  programme_id uuid not null references app.programmes(id) on delete cascade,
  owner_id uuid not null references app.users(id),
  title text not null check (length(title) between 1 and 200),
  platform text,
  status text not null default 'active'
    check (status in ('draft','active','disabled','archived','deletion_pending','deleted')),
  version int not null default 1,
  started_at timestamptz,
  ended_at timestamptz,
  disabled_at timestamptz,
  disabled_by uuid references app.users(id),
  legal_hold boolean not null default false,
  deletion_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on app.sessions(workspace_id, programme_id);

create table app.consents (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references app.sessions(id) on delete cascade,
  workspace_id uuid not null,
  user_id uuid not null references app.users(id),
  statement text not null,
  accepted_at timestamptz not null default now()
);

create table app.captures (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references app.sessions(id) on delete cascade,
  workspace_id uuid not null,
  user_id uuid not null references app.users(id),
  source_types text[] not null,
  permission_state jsonb not null default '{}'::jsonb,
  browser_info jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active','paused','stopped')),
  token_hash text,
  token_expires_at timestamptz,
  last_sequence int not null default 0,
  started_at timestamptz not null default now(),
  stopped_at timestamptz,
  stop_reason text
);
create index on app.captures(session_id);

-- ---------------------------------------------------------------- evidence
create table app.transcript_segments (
  id bigserial primary key,
  session_id uuid not null references app.sessions(id) on delete cascade,
  workspace_id uuid not null,
  capture_id uuid references app.captures(id) on delete set null,
  seq int not null,
  start_ms int not null,
  end_ms int not null,
  text text not null,
  speaker_label text not null default 'Speaker ?',
  confidence real,
  source text not null check (source in ('tab_audio','microphone','upload','manual','captions')),
  created_at timestamptz not null default now(),
  tsv tsvector generated always as (to_tsvector('simple', coalesce(text,''))) stored,
  embedding extensions.vector(1536)
);
create index on app.transcript_segments(session_id, start_ms);
create index on app.transcript_segments using gin(tsv);

create table app.visual_evidence (
  id bigserial primary key,
  session_id uuid not null references app.sessions(id) on delete cascade,
  workspace_id uuid not null,
  capture_id uuid references app.captures(id) on delete set null,
  timestamp_ms int not null,
  object_uri text,
  extracted_text text,
  type text not null default 'screen' check (type in ('slide','table','diagram','code','screen','document')),
  title text,
  is_transition boolean not null default false,
  confidence real,
  created_at timestamptz not null default now(),
  tsv tsvector generated always as (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(extracted_text,''))) stored
);
create index on app.visual_evidence(session_id, timestamp_ms);
create index on app.visual_evidence using gin(tsv);

create table app.question_suggestions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references app.sessions(id) on delete cascade,
  workspace_id uuid not null,
  text text not null,
  rationale text,
  category text not null check (category in ('strategic','technical','clarification','risk','decision','follow_up')),
  priority text not null check (priority in ('critical','high','medium','low')),
  confidence real not null check (confidence between 0 and 1),
  evidence_refs jsonb not null default '[]'::jsonb,
  tool_refs jsonb not null default '[]'::jsonb,
  state text not null default 'suggested' check (state in ('suggested','saved','dismissed','answered')),
  answer_text text,
  answer_refs jsonb not null default '[]'::jsonb,
  answer_confirmed boolean not null default false,
  feedback text check (feedback in ('up','down')),
  dedupe_key text not null,
  model_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, dedupe_key)
);
create index on app.question_suggestions(session_id, created_at);

create table app.knowledge_artifacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  programme_id uuid not null references app.programmes(id) on delete cascade,
  session_id uuid references app.sessions(id) on delete cascade,
  artifact_type text not null check (artifact_type in ('summary','decision','action','glossary','open_question','topic','contradiction','gap')),
  content jsonb not null,
  provenance_refs jsonb not null default '[]'::jsonb,
  version int not null default 1,
  status text not null default 'current' check (status in ('current','superseded','archived','corrected')),
  model_meta jsonb not null default '{}'::jsonb,
  created_by uuid references app.users(id),
  created_at timestamptz not null default now(),
  tsv tsvector generated always as (to_tsvector('simple', coalesce(content::text,''))) stored
);
create index on app.knowledge_artifacts(programme_id, artifact_type);
create index on app.knowledge_artifacts using gin(tsv);

create table app.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  programme_id uuid references app.programmes(id) on delete cascade,
  session_id uuid references app.sessions(id) on delete cascade,
  owner_id uuid not null references app.users(id),
  title text not null,
  object_uri text,
  mime_type text not null,
  size_bytes bigint not null,
  sha256 text,
  processing_state text not null default 'pending' check (processing_state in ('pending','scanning','processing','ready','failed','rejected')),
  error text,
  extracted_text text,
  retention_until timestamptz,
  created_at timestamptz not null default now(),
  tsv tsvector generated always as (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(extracted_text,''))) stored
);
create index on app.documents using gin(tsv);

-- ---------------------------------------------------------------- durable jobs + live events
create table app.jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  session_id uuid references app.sessions(id) on delete cascade,
  kind text not null check (kind in ('asr','ocr','questions','knowledge','document','purge')),
  payload jsonb not null default '{}'::jsonb,
  state text not null default 'queued' check (state in ('queued','running','done','failed','cancelled','dead')),
  attempts int not null default 0,
  max_attempts int not null default 3,
  last_error text,
  run_after timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on app.jobs(state, run_after);
create index on app.jobs(session_id);

create table app.events (
  seq bigserial primary key,
  session_id uuid not null references app.sessions(id) on delete cascade,
  workspace_id uuid not null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index on app.events(session_id, seq);

-- ---------------------------------------------------------------- audit (append-only, hash-chained)
create table app.audit_events (
  id bigserial primary key,
  workspace_id uuid,
  actor_id uuid,
  target_type text not null,
  target_id text,
  action text not null,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  prev_hash text,
  hash text
);
create index on app.audit_events(workspace_id, occurred_at);

create or replace function app.audit_chain() returns trigger language plpgsql as $$
declare last text;
begin
  perform pg_advisory_xact_lock(424242);
  select hash into last from app.audit_events order by id desc limit 1;
  new.prev_hash := coalesce(last, 'genesis');
  new.hash := encode(extensions.digest(new.prev_hash || '|' || coalesce(new.workspace_id::text,'') || '|' || coalesce(new.actor_id::text,'')
     || '|' || new.target_type || '|' || coalesce(new.target_id,'') || '|' || new.action || '|' || new.metadata::text || '|' || new.occurred_at::text, 'sha256'), 'hex');
  return new;
end $$;
create trigger audit_chain before insert on app.audit_events for each row execute function app.audit_chain();

create or replace function app.audit_immutable() returns trigger language plpgsql as $$
begin raise exception 'audit_events is append-only'; end $$;
create trigger audit_no_update before update or delete on app.audit_events for each row execute function app.audit_immutable();

create or replace function app.audit(p_ws uuid, p_actor uuid, p_type text, p_target text, p_action text, p_meta jsonb default '{}'::jsonb)
returns void language sql as $$
  insert into app.audit_events(workspace_id, actor_id, target_type, target_id, action, metadata) values (p_ws, p_actor, p_type, p_target, p_action, coalesce(p_meta,'{}'::jsonb));
$$;

-- ---------------------------------------------------------------- billing
create table app.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.users(id) on delete cascade,
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  provider text not null check (provider in ('razorpay','mock')),
  provider_subscription_id text not null unique,
  plan_id text not null,
  status text not null default 'created' check (status in ('created','authenticated','active','pending','halted','cancelled','completed','expired','paused')),
  current_period_end timestamptz,
  checkout_url text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on app.subscriptions(user_id);

create table app.billing_events (
  id bigserial primary key,
  provider text not null,
  event_id text not null,
  type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  unique (provider, event_id)
);

-- ---------------------------------------------------------------- AI agent tools (remote MCP, per workspace)
create table app.mcp_servers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  name text not null,
  url text not null check (url ~ '^https://' or url ~ '^http://(localhost|127\.0\.0\.1)'),
  auth_secret_enc text,
  enabled boolean not null default true,
  tool_allowlist text[] not null default '{}',
  created_by uuid references app.users(id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- session state machine
create or replace function app.session_transition_allowed(p_from text, p_to text) returns boolean language sql immutable as $$
  select (p_from, p_to) in (
    ('draft','active'), ('active','disabled'), ('disabled','active'),
    ('active','archived'), ('disabled','archived'), ('draft','archived'),
    ('draft','deletion_pending'), ('active','deletion_pending'), ('disabled','deletion_pending'), ('archived','deletion_pending'),
    ('deletion_pending','archived'), ('deletion_pending','deleted')
  );
$$;

-- Transactional, idempotent transition. Returns the session row as json.
create or replace function app.transition_session(p_session uuid, p_actor uuid, p_to text, p_reason text default 'user_requested', p_expected_version int default null)
returns jsonb language plpgsql as $$
declare s app.sessions; prev text; ev text;
begin
  select * into s from app.sessions where id = p_session for update;
  if not found then raise exception 'session_not_found' using errcode = 'P0002'; end if;
  if s.status = p_to then return to_jsonb(s); end if;                       -- idempotent
  if p_expected_version is not null and p_expected_version <> s.version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;
  if not app.session_transition_allowed(s.status, p_to) then
    raise exception 'invalid_transition:%->%', s.status, p_to using errcode = '22023';
  end if;
  if p_to = 'deleted' and s.legal_hold then raise exception 'legal_hold' using errcode = '22023'; end if;
  prev := s.status;
  update app.sessions set
    status = p_to, version = version + 1, updated_at = now(),
    disabled_at = case when p_to = 'disabled' then now() when p_to = 'active' then null else disabled_at end,
    disabled_by = case when p_to = 'disabled' then p_actor when p_to = 'active' then null else disabled_by end,
    deletion_requested_at = case when p_to = 'deletion_pending' then now() else deletion_requested_at end,
    ended_at = case when p_to in ('archived','disabled') and ended_at is null then now() else ended_at end
  where id = p_session returning * into s;

  if p_to <> 'active' then
    -- stop all active captures, revoke tokens, record CaptureStopped
    with stopped as (
      update app.captures set status = 'stopped', stopped_at = now(), stop_reason = 'session_' || p_to, token_hash = null, token_expires_at = null
      where session_id = p_session and status <> 'stopped' returning id, last_sequence)
    insert into app.events(session_id, workspace_id, type, payload)
      select p_session, s.workspace_id, 'CaptureStopped', jsonb_build_object('capture_id', id, 'stopped_at', now(), 'stop_reason', 'session_' || p_to, 'last_sequence', last_sequence) from stopped;
    -- cancel queued/running work, record ProcessingCancelled
    with cancelled as (
      update app.jobs set state = 'cancelled', updated_at = now(), last_error = 'session_' || p_to
      where session_id = p_session and state in ('queued','running') returning id)
    insert into app.events(session_id, workspace_id, type, payload)
      select p_session, s.workspace_id, 'ProcessingCancelled', jsonb_build_object('job_id', id, 'reason', 'session_' || p_to, 'occurred_at', now()) from cancelled;
  end if;

  ev := case p_to when 'disabled' then 'SessionDisabled' when 'active' then 'SessionEnabled' when 'archived' then 'SessionArchived'
              when 'deletion_pending' then 'SessionDeletionPending' when 'deleted' then 'SessionDeleted' else 'SessionStatusChanged' end;
  insert into app.events(session_id, workspace_id, type, payload)
    values (p_session, s.workspace_id, ev, jsonb_build_object('event_id', gen_random_uuid(), 'session_id', p_session, 'workspace_id', s.workspace_id,
            'actor_id', p_actor, 'occurred_at', now(), 'reason_code', p_reason, 'previous_status', prev, 'status', p_to, 'version', s.version));
  perform app.audit(s.workspace_id, p_actor, 'session', p_session::text, 'session.status_changed',
          jsonb_build_object('from', prev, 'to', p_to, 'reason_code', p_reason, 'version', s.version));
  return to_jsonb(s);
end $$;

-- ---------------------------------------------------------------- server-side guards (defence in depth)
-- New evidence and derived outputs may only be written while the session is Active.
create or replace function app.require_active_session() returns trigger language plpgsql as $$
declare st text;
begin
  select status into st from app.sessions where id = new.session_id;
  if st is distinct from 'active' then
    raise exception 'session_not_active:%', coalesce(st,'missing') using errcode = '55000';
  end if;
  return new;
end $$;
create trigger guard_segments before insert on app.transcript_segments for each row execute function app.require_active_session();
create trigger guard_visual before insert on app.visual_evidence for each row execute function app.require_active_session();
create trigger guard_questions before insert on app.question_suggestions for each row execute function app.require_active_session();
create trigger guard_captures before insert on app.captures for each row execute function app.require_active_session();
create or replace function app.require_active_session_jobs() returns trigger language plpgsql as $$
declare st text;
begin
  if new.session_id is null or new.kind = 'purge' then return new; end if;
  select status into st from app.sessions where id = new.session_id;
  if st is distinct from 'active' then raise exception 'session_not_active:%', coalesce(st,'missing') using errcode = '55000'; end if;
  return new;
end $$;
create trigger guard_jobs before insert on app.jobs for each row execute function app.require_active_session_jobs();
create or replace function app.require_active_session_knowledge() returns trigger language plpgsql as $$
declare st text;
begin
  if new.session_id is null then return new; end if;
  select status into st from app.sessions where id = new.session_id;
  if st is distinct from 'active' then raise exception 'session_not_active:%', coalesce(st,'missing') using errcode = '55000'; end if;
  return new;
end $$;
create trigger guard_knowledge before insert on app.knowledge_artifacts for each row execute function app.require_active_session_knowledge();

-- ---------------------------------------------------------------- RLS: default deny everywhere
-- Schema "app" is not granted to anon/authenticated and is not in the REST API's exposed schemas.
-- RLS with no policies additionally denies any role that is not the table owner (the API's DB role).
do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname = 'app' loop
    execute format('alter table app.%I enable row level security', t.tablename);
  end loop;
end $$;
revoke all on all tables in schema app from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema app from anon, authenticated'; end if;
end $$;
