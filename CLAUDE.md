# CLAUDE.md — Pacy Backend

Guidance for Claude Code working in this repository.

## What this repo is

The **backend service** for Pacy, a prescription-tokenization platform on Cardano
preprod. Node.js + TypeScript + Fastify. It holds the Cardano service wallet, signs
mint/burn transactions (Mesh + Blockfrost), owns the Supabase Postgres schema, and
verifies auth JWTs. **The frontend is a separate repo — do not add UI here.**

Read `PROJECT.md` for product/scope and locked decisions (§13). Read `ARCHITECTURE.md`
for the technical contract (schema, chain design, API, env). Keep both in sync when
behavior changes.

## Golden rules

1. **Never put PII or health content on-chain.** The chain stores only token
   existence, quantity, time-lock, and a content hash. Everything identifying a human
   lives in Postgres.
2. **Never commit secrets.** `.env` is git-ignored. The service wallet mnemonic,
   Blockfrost id, Supabase service-role key, and QR secret never appear in code, logs,
   or commits.
3. **Always re-validate before a burn.** Status, expiry, and `uses_remaining` are
   checked server-side on every dispense/revoke — never trust the client.
4. **Preprod only.** `CARDANO_NETWORK=preprod`. No mainnet, ever, in this build.
5. **On-chain = rules, off-chain = identities.** If unsure where data belongs, that
   sentence decides it.

## Stack & conventions

- TypeScript strict mode. Validate all external input with `zod`.
- Fastify for HTTP. Chain logic isolated in `src/chain/`.
- Cardano via **Mesh** (`@meshsdk/core`) + **Blockfrost**. No self-run node.
- DB/Auth via **Supabase** (`@supabase/supabase-js`). Backend verifies user JWTs; it
  does not implement signup/login.
- Package manager: **npm**.
- Errors: throw typed errors; map to clean HTTP codes in one place.

## MCP tools available (use them)

- **Supabase MCP** — inspect tables (`list_tables`) before schema changes; apply
  migrations (`apply_migration`); debug with `get_logs` / `get_advisors`. Project URL:
  `https://rujemygoawvemvwewplq.supabase.co`.
- **Railway MCP** — deploy and inspect logs for the production service. Confirm before
  destructive actions.
- The **shadcn MCP** listed in `.mcp.json` is for the frontend repo — not used here.

## Working style for this hackathon

- Timeline is tight (see the phase plan). Prefer the smallest thing that demos
  end-to-end over completeness. Ship the critical path (mint → burn → reject) first.
- The **chain module is the highest-risk part** — spike it early with a plain Node
  script in `scripts/` before wiring it into routes.
- Keep `.env.example` updated whenever a new env var is introduced.
- Before marking chain work done, actually submit a tx on preprod and confirm it via
  Blockfrost — don't assume it built correctly.

## Phase workflow & frontend handoff

- The build runs in phases tracked in `PHASES.md` (local, git-ignored). Update its
  status markers as work progresses.
- **At the end of every phase, output a "Frontend Handoff Prompt"** — a paste-ready
  block for the separate frontend Claude Code session, capturing any new/frozen
  endpoints, response shapes, env vars, or auth behavior the frontend now depends on.
  Append a copy under the handoff log at the bottom of `PHASES.md`.
- Phase 3 is the contract-freeze point: after it, treat the auth + QR + scan shapes as
  stable and flag any later change loudly in a handoff.

## Commands (filled in as the project scaffolds)

```
npm run dev      # local Fastify with reload
npm run build    # tsc
npm start        # run built server
npm run seed     # seed verified accounts + stations
```
