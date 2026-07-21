-- Doctor signing keys.
--
-- The private half is generated in the doctor's browser and never leaves the device;
-- only the public key is stored here. This is what stops the backend inventing a
-- prescription attributed to a real doctor: it cannot produce a signature for a key
-- it does not hold.
--
-- Keys are never deleted. A doctor who re-enrols on a new device gets a new row and
-- the old one is marked revoked, so prescriptions signed by the old key remain
-- verifiable forever.
create table public.doctor_signing_keys (
  id          uuid primary key default gen_random_uuid(),
  doctor_id   uuid not null references public.profiles (id) on delete cascade,
  public_key  text not null,
  fingerprint text not null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

comment on table public.doctor_signing_keys is
  'ECDSA P-256 public keys for doctor prescription signing. Private keys live only in the doctor''s browser.';
comment on column public.doctor_signing_keys.public_key is 'SPKI DER, base64-encoded.';
comment on column public.doctor_signing_keys.fingerprint is 'First 16 hex chars of sha256(spki bytes) — shown in the UI so a doctor can compare devices.';
comment on column public.doctor_signing_keys.revoked_at is 'Null means active. Retained after revocation so old signatures stay verifiable.';

-- At most one active key per doctor. Enforced by the database rather than by the
-- enrolment route, so a concurrent double-enrol cannot leave two usable keys.
create unique index doctor_signing_keys_one_active
  on public.doctor_signing_keys (doctor_id)
  where revoked_at is null;

create index doctor_signing_keys_doctor on public.doctor_signing_keys (doctor_id);

alter table public.doctor_signing_keys enable row level security;

-- Which key signed this prescription, and the signature itself.
--
-- Nullable: prescriptions minted before signing existed have neither, and rewriting
-- history to pretend otherwise would defeat the point of an audit trail.
alter table public.prescriptions
  add column doctor_signature text,
  add column signing_key_id   uuid references public.doctor_signing_keys (id);

comment on column public.prescriptions.doctor_signature is
  'ECDSA P-256 signature (raw r||s, base64) over the canonical JSON of the prescription content. Null for rows predating doctor signing.';
comment on column public.prescriptions.signing_key_id is
  'The key that produced doctor_signature. Recorded so re-enrolment never invalidates history.';
