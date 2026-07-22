# ARCHITECTURE.md — Pacy Backend

The technical contract for the Pacy **backend** service. Read alongside `PROJECT.md`
(product/scope) and `CLAUDE.md` (how to work in this repo).

This service is the **only** component that touches the Cardano service wallet and the
only writer to the database. The frontend (separate repo) and the IoT stations
(teammate) talk to it over HTTPS.

---

## 1. Responsibilities

This service, and only this service:

1. Verifies Supabase-issued auth JWTs and enforces role/verification rules.
2. Issues and verifies the rotating **patient QR token**.
3. Authenticates IoT stations via per-station API keys.
4. Reads/writes all off-chain data in Supabase Postgres.
5. Holds the service wallet key and builds/signs/submits **mint** and **burn**
   transactions via Mesh + Blockfrost on Cardano **preprod**.
6. Computes and records the prescription **content hash**.

It does **not** render UI, does **not** run on Deno/Edge, and never puts PII or health
content on-chain.

---

## 2. Runtime & stack

| Concern | Choice |
| ------- | ------ |
| Language | TypeScript (strict) on Node.js (LTS ≥ 20) |
| HTTP framework | Fastify |
| Cardano SDK | Mesh (`@meshsdk/core`) |
| Chain provider | Blockfrost (preprod) |
| DB / Auth | Supabase (Postgres + Auth), `@supabase/supabase-js` |
| Validation | `zod` |
| Hashing/JWT | Node `crypto`, `jsonwebtoken` |
| Deploy | Railway |
| Package manager | npm |

> **Note:** the current `package.json` contains `shadcn` (a frontend tool) from the
> initial commit. Phase 0 re-initializes it for a backend service and removes that dep.

---

## 3. Component diagram

```
Next.js PWA (separate repo)                 IoT stations (Raspberry Pi, teammate)
   │  Supabase JWT (Bearer)                    │  X-Station-Key + patient QR token
   ▼                                           ▼
┌──────────────────────────────────────────────────────────────┐
│                 Pacy Backend (Fastify, Railway)               │
│                                                              │
│  auth (JWT verify) · station auth · QR issue/verify           │
│  prescriptions (create/mint, dispense/burn, revoke)           │
│  chain module (Mesh + Blockfrost) · content hash              │
└───────────────┬───────────────────────────────┬──────────────┘
                │                                 │
        Supabase Postgres                 Mesh + Blockfrost ──► Cardano preprod
        (identities, content,             (mint N / burn 1 / time-lock)
         token_events, stations)
```

---

## 4. Database schema (owned by this repo)

Migrations live in `supabase/migrations/`. Applied via the Supabase MCP
(`apply_migration`) or the Supabase CLI. `id`s are `uuid` unless noted.

```
-- Auth identities live in Supabase auth.users. This mirror table adds role/profile.
profiles
  id (= auth.users.id, PK)   role: 'patient' | 'doctor' | 'pharmacy'
  full_name, created_at

doctors
  user_id (FK profiles.id)   hpcsa_number
  verification_status: 'pending' | 'verified' | 'rejected'   verified_at

pharmacies
  user_id (FK profiles.id)   sapc_number
  verification_status        verified_at

prescriptions
  id                         patient_id (FK)   doctor_id (FK)
  drug_details (jsonb)       content_hash (text)
  max_uses (int)             uses_remaining (int)
  expires_at (timestamptz NULL = no expiry)
  policy_id (text)  asset_name (text)  mint_tx_hash (text)
  status: 'active' | 'fully_dispensed' | 'expired' | 'revoked'
  created_at

token_events                 -- audit trail + sellable dataset
  id   prescription_id (FK)
  event_type: 'mint' | 'burn' | 'revoke'
  actor_id (FK profiles.id)  actor_role: 'doctor' | 'pharmacy'
  station_id (FK stations.id NULL)   tx_hash (text)
  created_at

stations                     -- IoT terminal credentials
  id   type: 'doctor' | 'pharmacy'
  label   owner_user_id (FK)   api_key_hash (text)   created_at

consent
  id   patient_id (FK)   scope   granted_at   revoked_at (NULL)
```

Seed data (Phase 1): 1 verified doctor, 1 verified pharmacy, 1 patient, 1 doctor
station, 1 pharmacy station (raw API keys printed once to console for the IoT teammate).

---

## 5. Cardano design (native scripts, no Plutus)

**Per-prescription native minting policy.**

- **No expiry:** `{ "type": "sig", "keyHash": <serviceKeyHash> }`
- **With expiry:** `{ "type": "all", "scripts": [ { "type": "sig", "keyHash": <serviceKeyHash> }, { "type": "before", "slot": <expirySlot> } ] }`
  - `before(slot)` = tx invalid at/after that slot → the chain **refuses to validate a
    burn after expiry**. This is the core demo moment.

**Asset:** `asset_name = hex(prescription_id)` → globally unique token per prescription.
`quantity = max_uses`.

**Mint (doctor creates prescription):**
1. Insert prescription row (`status='active'`, `uses_remaining=max_uses`).
2. Compute `content_hash` (§6).
3. Build tx: mint `(policyId, assetName, +max_uses)`, attach metadata (label 674)
   `{ content_hash, prescription_id, v: 1 }`, set `invalidHereafter = expirySlot` if
   expiry.
4. Sign with service key, submit via Blockfrost.
5. Persist `policy_id`, `asset_name`, `mint_tx_hash`; insert `token_events` (`mint`,
   actor = doctor).

**Burn (pharmacy dispenses 1 unit):**
1. Re-check off-chain: status `active`, not expired, `uses_remaining > 0`.
2. Confirm on-chain balance via Blockfrost.
3. Build tx: mint `(policyId, assetName, -1)`; sign; submit.
4. `uses_remaining -= 1`; if `0` → status `fully_dispensed`. Insert `token_events`
   (`burn`, actor = pharmacy, station_id).

**Revoke (doctor):** burn all `uses_remaining`, status → `revoked`, `token_events`
(`revoke`).

**Expiry sweep:** a lightweight check marks past-`expires_at` `active` rows as `expired`
lazily on read (no cron needed for the MVP).

Slot conversion uses the Cardano preprod shelley genesis parameters (see
`src/chain/slots.ts`).

---

## 6. Content hash

`content_hash = sha256( canonicalJSON )` where `canonicalJSON` is the prescription
content with **sorted keys**, over exactly:

```
{ patient_id, doctor_id, drug_details, max_uses, expires_at }
```

Stored in `prescriptions.content_hash` and in mint tx metadata → lets anyone later prove
the off-chain record was not tampered with.

---

## 7. IoT station integration contract

Each station holds a per-station API key (issued at seed time, shown once).

**Scan a patient QR (both doctor and pharmacy stations use this):**

```
POST /stations/scan
Headers: X-Station-Key: <raw station api key>
Body:    { "qr_token": "<the JWT read from the patient's QR>" }

200 → {
  "patient": { "id", "full_name" },
  "station_type": "doctor" | "pharmacy",
  // doctor station: patient basic context
  // pharmacy station: active, non-expired prescriptions with uses_remaining
  "prescriptions": [ ... ]   // present for pharmacy stations
}
401 → invalid/expired station key
422 → invalid/expired qr_token
```

The station's job is only: read the QR → POST it here. No chain access, no DB access
from the Pi.

**How the doctor/pharmacy _browser_ learns a scan happened.** The IoT scanner is a
separate device from the operator's PC, so the browser can't see the scan directly. The
backend bridges them:

1. `POST /stations/scan` (from the Pi) stores the scan result server-side, keyed by
   station — a short-lived "current scan" for that station.
2. The operator's browser (logged in as the station owner) **polls**
   `GET /stations/current-scan` (~every 1.5s while on the "waiting for patient" screen).
   It atomically consumes and returns the latest scan for the caller's station, then
   the browser proceeds with that patient's context. Later polls return `204` until
   the Pi posts a genuinely new scan.

We use polling, not Supabase Realtime — fewer moving parts under the deadline and it
works even before the IoT firmware is ready.

**Browser-camera fallback (no Pi needed).** For demos or when a station isn't wired up,
the browser can scan the QR with its own camera and call `POST /scan` directly
(authenticated with the operator's Bearer JWT, **not** a station key), which returns the
same patient context inline — no polling. This is what makes the whole loop demoable
from laptops alone.

---

## 8. HTTP API (draft)

All non-station endpoints require `Authorization: Bearer <supabase_jwt>`.

| Method & path | Role | Purpose |
| ------------- | ---- | ------- |
| `GET /health` | — | Liveness (DB + Blockfrost reachable) |
| `GET /me` | any | Current identity + role from JWT |
| `GET /patient/qr-token` | patient | Issue 30s rotating QR JWT |
| `GET /patient/prescriptions` | patient | Own history (mint/burn events, uses left, expiry) |
| `POST /stations/scan` | station key | IoT scanner posts a scanned QR (§7) |
| `GET /stations/current-scan` | doctor/pharmacy | Browser polls for the latest scan on its station (§7); `204` if none |
| `POST /scan` | doctor/pharmacy | Browser-camera fallback: post a QR token, get patient context inline (§7) |
| `POST /prescriptions` | doctor (verified) | Create + **mint** |
| `POST /prescriptions/:id/dispense` | pharmacy (verified) | **Burn** 1 unit |
| `POST /prescriptions/:id/revoke` | doctor | **Burn** all remaining |

**`POST /prescriptions` body** (`expires_at` is ISO 8601 UTC or `null` = no expiry):

```jsonc
{
  "patient_id": "<uuid>",
  "drug_details": { "drug": "…", "dosage": "…", "instructions": "…", "diagnosis": "…" },
  "max_uses": 3,
  "expires_at": "2026-08-01T00:00:00Z"   // or null
}
```

Revoked prescriptions remain visible in patient history with `status: "revoked"`.

**`GET /me` response (FROZEN — the frontend types against this):**

```jsonc
{
  "id": "9edb541a-bff7-4157-9674-cb71164a2bda",
  "role": "doctor",                 // exactly "patient" | "doctor" | "pharmacy" (lowercase)
  "full_name": "Dr. Naledi Mokoena",
  "station_id": "daa252fa-...",     // the station this user operates; null for patients
  "verification": {                 // null for patients
    "body": "HPCSA",                // "HPCSA" for doctors, "SAPC" for pharmacies
    "registration_number": "MP0123456",
    "status": "verified"            // "pending" | "verified" | "rejected"
  }
}
```

`station_id` is what the doctor/pharmacy browser polls `GET /stations/current-scan`
with. It is `null` for patients, who own no station.

Auth (signup/login) is handled by Supabase on the frontend; the backend only **verifies**
the resulting JWT and looks up role in `profiles`.

**JWT verification:** this Supabase project uses **asymmetric JWT signing keys (ECC
P-256 / ES256)**, so there is no shared HMAC secret. The backend verifies incoming user
JWTs against the project's public JWKS at
`$SUPABASE_URL/auth/v1/.well-known/jwks.json` (fetched once and cached, via `jose`).
`SUPABASE_JWT_SECRET` stays unset unless the project is ever moved back to a legacy
HS256 shared secret.

---

## 9. Configuration (`.env`)

```
PORT=8080
NODE_ENV=development

# Supabase
SUPABASE_URL=https://rujemygoawvemvwewplq.supabase.co
SUPABASE_SERVICE_ROLE_KEY=      # server-side only
SUPABASE_JWT_SECRET=            # to verify incoming user JWTs

# Cardano
BLOCKFROST_PROJECT_ID=preprod...
CARDANO_NETWORK=preprod
SERVICE_WALLET_MNEMONIC=        # 15/24-word phrase, NEVER commit

# Backend-issued patient QR token
QR_TOKEN_SECRET=
QR_TOKEN_TTL_SECONDS=30
```

An `.env.example` (no secret values) is committed; `.env` is git-ignored.

---

## 10. Proposed source layout

```
src/
  server.ts            # Fastify bootstrap
  config.ts            # env parsing (zod)
  db/                  # supabase client + typed queries
  auth/                # jwt verify, role guard, station-key guard
  qr/                  # issue + verify patient QR token
  chain/
    wallet.ts          # load service wallet (Mesh)
    provider.ts        # Blockfrost
    policy.ts          # build per-prescription native script
    slots.ts           # date <-> preprod slot
    mint.ts  burn.ts   # tx builders
    hash.ts            # content hash
  routes/
    health.ts me.ts patient.ts stations.ts prescriptions.ts
  lib/                 # errors, canonical-json, logger
supabase/migrations/   # SQL migrations
scripts/               # chain spike, seed
```

---

## 11. Security notes

- Service wallet mnemonic, Blockfrost id, Supabase service-role key, and QR secret are
  the crown jewels — `.env` only, git-ignored, and set as Railway variables in prod.
- Backend always **re-validates** status/expiry/uses before building any burn — never
  trust the client.
- Station keys are stored hashed; compared with a constant-time check.
- Preprod testnet throughout — no real funds at risk.
