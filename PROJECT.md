# PROJECT.md — Pacy

## 1. What this is

**Pacy** is a prescription-tokenization platform. A doctor mints a prescription as a
blockchain token tied to a patient. A pharmacy burns that token when dispensing the
medication. The blockchain guarantees a prescription cannot be forged, reused beyond
its allowed number of fills, or dispensed after it expires — without ever storing any
patient health data on a public ledger.

Tagline: _"One prescription. One token. One time."_

Built for a 6-day timeline. Blockchain: **Cardano**, on **preprod testnet** throughout
(no real funds, no production chain risk). Region for MVP/pitch: **South Africa**
(HPCSA / SAPC regulator integration framing), explicitly designed to generalize to
other countries later.

---

## 2. Problem statement

Paper and even naive digital prescriptions can be:

- Copied/forged.
- Filled more times than intended.
- Filled after they should no longer be valid.
- Hard to audit — no reliable record of who dispensed what, where, when.

Scrip fixes the _reuse and forgery_ problem by making the prescription's core lifecycle
(exists → partially used → fully used/expired) a fact enforced by a blockchain ledger,
not just a database row an administrator could edit.

---

## 3. Core actors

| Actor        | Device                                     | Role                                                                      |
| ------------ | ------------------------------------------ | ------------------------------------------------------------------------- |
| **Patient**  | Mobile phone (web app)                     | Shows a rotating identity QR code. Views own prescription history.        |
| **Doctor**   | PC + IoT scanner device (doctor station)   | Scans patient QR → writes prescription → mints token.                     |
| **Pharmacy** | PC + IoT scanner device (pharmacy station) | Scans patient QR → selects active prescription → dispenses → burns token. |

There are **two IoT scanner devices** — one at the doctor's station, one at the
pharmacy's station. Both do the same fundamental job (scan the patient's QR and open
the right dashboard context) and each also authenticates its own station via a scoped
terminal credential (not a shared username/password). _(IoT hardware build owned by a
separate team member — this doc defines the software/API contract it must integrate
with.)_

---

## 4. The patient QR — rotating identity token

The QR code the patient displays represents **the patient's identity, not a specific
prescription.** Both the doctor and pharmacy scan the _same_ QR.

- The patient's app requests a short-lived signed token from the backend
  (`patient_id + expiry`), renders it as a QR code, and **automatically refreshes it
  every 30 seconds.**
- A terminal that scans the QR sends the token to the backend, which verifies the
  signature and expiry before returning that patient's data.
- This means a photographed/screenshotted QR is useless after ~30 seconds — it kills
  the obvious "copy the QR" attack without needing the patient to hold their own
  blockchain keys in the MVP.

---

## 5. On-chain vs. off-chain — the core architectural rule

**Rule:** off-chain data is fine as long as the _security guarantee_ lives on-chain.
Nothing that identifies a human, and no health content, ever touches the chain.

### On-chain (Cardano, enforced by the ledger itself)

- **Token existence** — a minted asset represents "a valid prescription exists."
- **Multi-use / refills** — mint **N units** of the token for an N-fill prescription;
  each dispense **burns 1 unit**. Remaining refills = on-chain token balance. The
  ledger physically cannot burn more units than exist, so over-use is impossible by
  construction. A single-use prescription is just N = 1. **No smart contract needed**
  — this falls out of standard mint/burn semantics.
- **Expiration** — enforced via a **native script time-lock** (`invalid-hereafter`) on
  the minting policy. After the expiry slot, the chain refuses to validate a burn
  transaction for that token. Prescriptions with **no expiry** mint under a plain
  signature-only native policy (no time-lock) — "unlimited" is simply the absence of
  the time bound.
- **Content hash** — a hash of the prescription's off-chain content, stored in
  transaction metadata, so the off-chain record can later be proven un-tampered.

### Off-chain (Postgres database)

- All prescription **content**: drug, dosage, instructions, diagnosis context.
- All **identities**: patient, doctor, pharmacy accounts and profiles.
- **Who / where / when** for every mint and burn (see `token_events` below) — this is
  PII and cannot legally or practically live on a public chain, and it's also the
  dataset the business model is built on.
- Regulator verification fields (HPCSA number for doctors, SAPC number for
  pharmacies/pharmacists) and their verification status.
- Consent records, subscriptions/billing, auth.

> Why this isn't a compromise: the chain enforces the _rules_ (can't double-spend,
> can't over-fill, can't dispense after expiry). The database records the _identities_
> — which is exactly where PII legally belongs, and exactly what a monetizable
> analytics layer needs anyway.

---

## 6. Data model (high-level)

```
users
  id, role (patient | doctor | pharmacy), auth fields, profile

doctors
  user_id, hpcsa_number, verification_status, verified_at

pharmacies
  user_id, sapc_number, verification_status, verified_at

prescriptions
  id, patient_id, doctor_id
  drug_details (off-chain content)
  content_hash
  max_uses, uses_remaining
  expires_at            -- NULLABLE = unlimited / no expiry
  policy_id, asset_name, mint_tx_hash
  status: active | fully_dispensed | expired | revoked

token_events            -- audit trail + sellable dataset
  id, prescription_id
  event_type: mint | burn | revoke
  actor_id, actor_role (doctor | pharmacy)
  location / station_id
  tx_hash
  created_at

consent
  patient_id, scope, granted_at, revoked_at
```

`expires_at` nullable handles "some prescriptions have unlimited expiry" — null skips
the time-lock branch entirely at mint time.

---

## 7. End-to-end workflow

1. **Patient** opens the app → sees a rotating QR (regenerates every 30s) and their
   full prescription history (minted/burned events, expiry, uses remaining).
2. **Doctor** station: IoT scanner reads patient QR → backend verifies token → doctor
   dashboard opens that patient's context → doctor writes prescription (drug, dosage,
   number of allowed fills, expiry or "no expiry") → submits.
3. Backend writes the off-chain prescription record, computes content hash, builds a
   **mint** transaction (Mesh SDK) — quantity = number of fills, policy = signature
   [+ time-lock if expiry set] — signs with the service key, submits via Blockfrost.
   Logs a `token_events` row (`mint`, doctor as actor).
4. **Pharmacy** station: IoT scanner reads the _same_ patient QR → pharmacy dashboard
   shows that patient's active, non-expired prescriptions with uses remaining.
5. Pharmacist selects one, confirms dispense. Backend re-checks status/expiry/
   uses_remaining, confirms on-chain balance via Blockfrost, builds a **burn**
   transaction for 1 unit, signs, submits. Decrements `uses_remaining`; if it hits 0,
   status → `fully_dispensed`. Logs a `token_events` row (`burn`, pharmacy as actor).
6. If someone attempts to reuse a fully-dispensed, expired, or revoked prescription,
   the backend check fails fast, and even if it didn't, the chain itself would reject
   the transaction — this rejection path is the core demo moment.

---

## 8. Practitioner verification (South Africa MVP)

Two separate regulator tracks — different bodies, same pattern:

- **Doctors** → verified against **HPCSA** (Health Professions Council of South
  Africa) registration number.
- **Pharmacies / pharmacists** → verified against **SAPC** (South African Pharmacy
  Council) registration number — a _different_ statutory body under the Pharmacy Act.

Neither regulator exposes a public API for automated verification, and their lookup
pages explicitly disallow automated access. **For the MVP: seed a small set of
pre-verified doctor/pharmacy accounts in the database** (`verification_status`,
`hpcsa_number` / `sapc_number` fields already in the schema). Do not scrape either
regulator's site.

Pitch framing: _"Doctor identity is anchored to HPCSA registration; pharmacy identity
to SAPC registration. This MVP validates against a seeded internal registry; a
production version would integrate via a formal data-sharing agreement with each body
— the same `regulator_body` + `registration_number` pattern extends to other
countries' equivalent regulators as the platform scales beyond South Africa."_

---

## 9. Tech stack (agreed with team)

**Blockchain**

- Cardano, preprod testnet.
- **On-chain logic:** native scripts (signature + optional time-lock). No Aiken/Plutus
  for the MVP unless time allows as a stretch goal (e.g. requiring pharmacy
  co-signature on burn).
- **Chain access:** Blockfrost (hosted API — no self-run node).
- **Chain SDK:** Mesh SDK (TypeScript) — builds/signs/submits transactions.

**Backend / data**

- **Supabase**: Postgres DB + built-in Auth (role field: patient/doctor/pharmacy).
  Supabase is used purely as the database + auth provider.
- **Cardano signing + business logic:** a small dedicated **Node.js + TypeScript
  service (Fastify) deployed on Railway**. This service holds the service wallet key,
  builds/signs/submits transactions via **Mesh + Blockfrost**, connects to the
  Supabase Postgres database, and verifies Supabase-issued auth JWTs on incoming
  requests.
  - _Why a separate Node service instead of Supabase Edge Functions:_ Edge Functions
    run on Deno, and Mesh's WASM/Node-built-in dependencies are only reliably known to
    work in a standard Node runtime. The chain layer is the highest-risk,
    can't-be-faked part of the project — putting it in plain Node removes the
    bundler/runtime gamble entirely. Cost is one extra deploy (~10 min on Railway),
    which is cheap insurance on the critical path.
  - _Bonus:_ the day-1 chain spike is a plain Node script that becomes the seed of this
    service — no throwaway work.
- ORM: optional. Use the Supabase JS client or a light query layer; only add Prisma if
  it clearly speeds you up, not by default.

**Architecture shape (3 pieces, each one job):**

```
Next.js PWA (Vercel)  ──HTTPS──►  Node API service (Railway)  ──►  Mesh + Blockfrost ──► Cardano
       │                                   │
       └──────── Supabase Auth ────────────┴──────►  Supabase Postgres
       (JWT issued to client,                        (data read/written by
        verified by the API service)                  the API service)
```

**Frontend**

- **Next.js**, built as a **PWA** (installable, camera access for QR).
- Camera access used for QR display (patient) and, where relevant, browser-based
  scanning as a fallback/complement to the dedicated IoT scanners.
- One responsive app, three role-based views (patient on mobile, doctor/pharmacy on
  PC) — not three separate apps.
- **Deployment:** Vercel.

**Design**

- **Tailwind CSS + shadcn/ui** for components — fast, clean-by-default, minimal custom
  design effort needed given the timeline.
- Use the **shadcn MCP** in Claude Code to scaffold/install components directly —
  important for speed, note this explicitly in `CLAUDE.md` so Claude Code reaches for
  it instead of hand-rolling UI.

---

---

## 12. Explicit scope cuts (for this build)

- ❌ No patient-held blockchain keys / non-custodial signing — backend holds the
  service key and signs on behalf of all parties. Documented as a known MVP tradeoff;
  pharmacy/doctor co-signing on transactions is the natural decentralization upgrade.
- ❌ No Aiken/Plutus smart contracts unless day 5–6 has slack — native scripts cover
  uniqueness, refills, and expiry.
- ❌ No live HPCSA/SAPC API integration — seeded verified accounts only.
- ❌ No real IoT hardware build in this repo — integration contract only, hardware
  owned by teammate.
