-- Pacy initial schema
-- Applied to project rujemygoawvemvwewplq via the Supabase MCP.
--
-- On-chain = rules; off-chain (here) = identities, content, audit trail.
-- All access goes through the backend service-role client, so RLS is enabled with NO
-- permissive policies: the anon/authenticated keys can read nothing directly.

-- ---------- enums ----------
create type user_role as enum ('patient', 'doctor', 'pharmacy');
create type verification_status as enum ('pending', 'verified', 'rejected');
create type prescription_status as enum ('active', 'fully_dispensed', 'expired', 'revoked');
create type token_event_type as enum ('mint', 'burn', 'revoke');
create type station_type as enum ('doctor', 'pharmacy');

-- ---------- identities ----------
create table profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  role       user_role not null,
  full_name  text not null,
  created_at timestamptz not null default now()
);
comment on table profiles is 'Mirrors auth.users, adding role + display profile.';

create table doctors (
  user_id             uuid primary key references profiles (id) on delete cascade,
  hpcsa_number        text not null unique,
  verification_status verification_status not null default 'pending',
  verified_at         timestamptz
);
comment on table doctors is 'HPCSA registration. MVP verifies against seeded data, not a live API.';

create table pharmacies (
  user_id             uuid primary key references profiles (id) on delete cascade,
  sapc_number         text not null unique,
  verification_status verification_status not null default 'pending',
  verified_at         timestamptz
);
comment on table pharmacies is 'SAPC registration — a different statutory body from HPCSA.';

-- ---------- IoT stations ----------
create table stations (
  id            uuid primary key default gen_random_uuid(),
  type          station_type not null,
  label         text not null,
  owner_user_id uuid not null references profiles (id) on delete cascade,
  api_key_hash  text not null unique,
  created_at    timestamptz not null default now()
);
comment on column stations.api_key_hash is 'SHA-256 of the raw station key. Raw key is shown once at seed time.';

-- Latest scan per station, so the operator browser can poll for it.
-- One row per station: a new scan upserts over the old one.
create table station_scans (
  station_id  uuid primary key references stations (id) on delete cascade,
  patient_id  uuid not null references profiles (id) on delete cascade,
  scanned_at  timestamptz not null default now(),
  consumed_at timestamptz
);

-- ---------- prescriptions ----------
create table prescriptions (
  id             uuid primary key default gen_random_uuid(),
  patient_id     uuid not null references profiles (id),
  doctor_id      uuid not null references profiles (id),
  drug_details   jsonb not null,
  content_hash   text not null,
  max_uses       integer not null check (max_uses >= 1),
  uses_remaining integer not null check (uses_remaining >= 0),
  expires_at     timestamptz,
  policy_id      text,
  asset_name     text,
  mint_tx_hash   text,
  status         prescription_status not null default 'active',
  created_at     timestamptz not null default now(),
  constraint uses_remaining_within_max check (uses_remaining <= max_uses)
);
comment on column prescriptions.expires_at is 'NULL = no expiry; skips the native-script time-lock at mint time.';
comment on column prescriptions.content_hash is 'SHA-256 of canonical JSON; also written to mint tx metadata.';

-- ---------- audit trail ----------
create table token_events (
  id              uuid primary key default gen_random_uuid(),
  prescription_id uuid not null references prescriptions (id) on delete cascade,
  event_type      token_event_type not null,
  actor_id        uuid references profiles (id),
  actor_role      user_role,
  station_id      uuid references stations (id),
  tx_hash         text,
  created_at      timestamptz not null default now()
);
comment on table token_events is 'Who/where/when for every mint and burn. PII — never on-chain.';

create table consent (
  id         uuid primary key default gen_random_uuid(),
  patient_id uuid not null references profiles (id) on delete cascade,
  scope      text not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- ---------- indexes ----------
create index prescriptions_patient_idx on prescriptions (patient_id, status);
create index prescriptions_doctor_idx  on prescriptions (doctor_id);
create index prescriptions_asset_idx   on prescriptions (policy_id, asset_name);
create index token_events_rx_idx       on token_events (prescription_id, created_at desc);
create index stations_owner_idx        on stations (owner_user_id);
create index consent_patient_idx       on consent (patient_id);

-- ---------- RLS: locked down, backend-only ----------
alter table profiles      enable row level security;
alter table doctors       enable row level security;
alter table pharmacies    enable row level security;
alter table stations      enable row level security;
alter table station_scans enable row level security;
alter table prescriptions enable row level security;
alter table token_events  enable row level security;
alter table consent       enable row level security;
