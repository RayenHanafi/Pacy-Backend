/**
 * Path A (decentralized) HTTP routes. The user's own Cardano key signs every mint/burn;
 * the backend builds the unsigned transaction, the browser signs it, and the backend
 * co-signs (holding wallet) + submits. Two-step prepare/commit per action.
 *
 * These are NEW paths — the existing custodial routes in prescriptions.ts are untouched.
 * The frontend chooses which flow to use.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { stringToHex } from '@meshsdk/core';
import { requireRole, requireVerifiedRole } from '../auth/context.js';
import { loadPatient } from '../db/scan.js';
import {
  assertDispensable,
  attachMint,
  consumeUse,
  createPrescription,
  deletePrescription,
  effectiveStatus,
  getPrescription,
  recordEvent,
} from '../db/prescriptions.js';
import { getChainWallet, upsertChainWallet } from '../db/chain.js';
import { prescriptionContentHash } from '../lib/hash.js';
import { plutusContracts } from '../chain/plutus/config.js';
import { enrollKeyHash } from '../chain/plutus/settings.js';
import { ensureHoldingUtxos } from '../chain/plutus/backendWallet.js';
import { buildMintUnsigned, buildBurnUnsigned, coSignAndSubmit } from '../chain/plutus/prescriptionTx.js';
import { assetNameFor } from '../chain/policy.js';
import { AppError, forbidden } from '../lib/errors.js';

const idParam = z.object({ id: z.string().uuid() });

// A payment key hash is 28 bytes = 56 hex chars.
const enrolBody = z.object({
  address: z.string().min(1),
  key_hash: z.string().regex(/^[0-9a-fA-F]{56}$/, 'key_hash must be a 28-byte hex string'),
});

const prepareBody = z.object({
  patient_id: z.string().uuid(),
  // One prescription (one token, one expiry, one refill count) can carry several medicines.
  drug_details: z.object({
    medicines: z
      .array(
        z.object({
          drug: z.string().min(1),
          dosage: z.string().min(1),
          instructions: z.string().min(1),
        }),
      )
      .min(1)
      .max(20),
    diagnosis: z.string().optional(),
  }),
  max_uses: z.number().int().min(1).max(50),
  // Optional — a prescription may have no expiry. Omit it, or send null, or an ISO-8601 date.
  expires_at: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'expires_at must be an ISO-8601 date')
    .nullable()
    .optional(),
});

const commitBody = z.object({ prescription_id: z.string().uuid(), signed_tx: z.string().min(1) });
const dispenseCommitBody = z.object({ signed_tx: z.string().min(1) });

export async function chainPrescriptionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Enrol the caller's browser-held Cardano key. Stores the public address + key hash and
   * adds the key hash to the on-chain allow-list (admin-signed settings update), so their
   * signature will satisfy the minting policy. Only public data is stored — never the key.
   */
  app.post('/chain/wallet', { preHandler: requireVerifiedRole('doctor', 'pharmacy') }, async (request, reply) => {
    const { address, key_hash } = enrolBody.parse(request.body);
    const role = request.auth!.role as 'doctor' | 'pharmacy';

    // Holding wallet needs a buffer of clean UTxOs to fund the settings update.
    await ensureHoldingUtxos();
    await upsertChainWallet({ profile_id: request.auth!.id, role, address, key_hash });
    const { added, tx } = await enrollKeyHash(role, key_hash);

    return reply.status(201).send({ enrolled: true, role, key_hash, added, settings_tx: tx ?? null });
  });

  /** Whether the caller has enrolled a chain wallet. */
  app.get('/chain/wallet', { preHandler: requireRole('doctor', 'pharmacy') }, async (request) => {
    const wallet = await getChainWallet(request.auth!.id);
    if (!wallet) return { enrolled: false };
    return { enrolled: true, address: wallet.address, key_hash: wallet.key_hash, role: wallet.role };
  });

  /**
   * MINT step 1/2 — build the unsigned transaction. Creates the prescription row (so its
   * id is the on-chain asset name) and returns the tx for the doctor to sign in-browser.
   */
  app.post('/prescriptions/prepare', { preHandler: requireVerifiedRole('doctor') }, async (request, reply) => {
    const body = prepareBody.parse(request.body);
    const doctor = request.auth!;

    const wallet = await getChainWallet(doctor.id);
    if (!wallet) {
      throw new AppError('CHAIN_WALLET_NOT_ENROLLED', 'Set up your signing wallet on this device first');
    }

    const expiresAt = body.expires_at ?? null;
    if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) {
      throw new AppError('VALIDATION_ERROR', 'expires_at must be in the future');
    }

    await ensureHoldingUtxos(); // no-op when the clean-UTxO buffer is healthy; self-heals otherwise
    const patient = await loadPatient(body.patient_id);
    const content = {
      patient_id: patient.id,
      doctor_id: doctor.id,
      drug_details: body.drug_details,
      max_uses: body.max_uses,
      expires_at: expiresAt,
    };
    const contentHash = prescriptionContentHash(content);

    const row = await createPrescription({
      patient_id: patient.id,
      doctor_id: doctor.id,
      drug_details: body.drug_details,
      content_hash: contentHash,
      max_uses: body.max_uses,
      expires_at: expiresAt,
      doctor_signature: null,
      signing_key_id: null,
    });

    try {
      const assetNameHex = stringToHex(assetNameFor(row.id));
      const { unsignedTx } = await buildMintUnsigned({
        doctorKeyHash: wallet.key_hash,
        assetNameHex,
        quantity: body.max_uses,
        contentHash,
      });
      return reply.status(201).send({ prescription_id: row.id, unsigned_tx: unsignedTx });
    } catch (err) {
      // No token will exist — do not leave a dangling active row.
      await deletePrescription(row.id);
      throw err;
    }
  });

  /**
   * MINT step 2/2 — the doctor has signed; co-sign with the holding wallet, submit, and
   * finalise the row with its on-chain identity.
   */
  app.post('/prescriptions/commit', { preHandler: requireVerifiedRole('doctor') }, async (request) => {
    const { prescription_id, signed_tx } = commitBody.parse(request.body);
    const doctor = request.auth!;

    const row = await getPrescription(prescription_id);
    if (row.doctor_id !== doctor.id) throw forbidden('Not your prescription');

    let txHash: string;
    try {
      txHash = await coSignAndSubmit(signed_tx);
    } catch (err) {
      await deletePrescription(row.id);
      throw err;
    }

    const c = plutusContracts();
    const updated = await attachMint(row.id, {
      policy_id: c.policyId,
      asset_name: assetNameFor(row.id),
      tx_hash: txHash,
    });
    await recordEvent({
      prescription_id: row.id,
      event_type: 'mint',
      actor_id: doctor.id,
      actor_role: 'doctor',
      tx_hash: txHash,
    });

    request.log.info({ prescription: row.id, tx: txHash }, 'prescription minted (plutus)');
    return { ...updated, status: effectiveStatus(updated), mint_tx_hash: txHash };
  });

  /** DISPENSE step 1/2 — re-validate, then build the unsigned burn for the pharmacy. */
  app.post('/prescriptions/:id/dispense/prepare', { preHandler: requireVerifiedRole('pharmacy') }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const pharmacy = request.auth!;

    const wallet = await getChainWallet(pharmacy.id);
    if (!wallet) {
      throw new AppError('CHAIN_WALLET_NOT_ENROLLED', 'Set up your signing wallet on this device first');
    }

    const row = await getPrescription(id);
    assertDispensable(row); // status, expiry, uses — never trust the client

    await ensureHoldingUtxos(); // keep the holding buffer healthy for collateral/funding
    const assetNameHex = stringToHex(assetNameFor(row.id));
    const { unsignedTx } = await buildBurnUnsigned({
      pharmacyKeyHash: wallet.key_hash,
      assetNameHex,
      quantity: 1,
    });
    return reply.status(200).send({ prescription_id: row.id, unsigned_tx: unsignedTx });
  });

  /** DISPENSE step 2/2 — pharmacy signed; co-sign, submit, decrement uses. */
  app.post('/prescriptions/:id/dispense/commit', { preHandler: requireVerifiedRole('pharmacy') }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { signed_tx } = dispenseCommitBody.parse(request.body);
    const pharmacy = request.auth!;

    const row = await getPrescription(id);
    assertDispensable(row); // re-check at commit; the server is the source of truth

    const txHash = await coSignAndSubmit(signed_tx);

    const updated = await consumeUse(row.id, row.uses_remaining);
    await recordEvent({
      prescription_id: row.id,
      event_type: 'burn',
      actor_id: pharmacy.id,
      actor_role: 'pharmacy',
      station_id: pharmacy.station_id,
      tx_hash: txHash,
    });

    request.log.info({ prescription: row.id, tx: txHash, remaining: updated.uses_remaining }, 'prescription dispensed (plutus)');
    return { ...updated, status: effectiveStatus(updated), burn_tx_hash: txHash };
  });
}
