import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
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
  listForDoctor,
  markRevoked,
  recordEvent,
} from '../db/prescriptions.js';
import { mintPrescriptionToken } from '../chain/mint.js';
import { burnPrescriptionUnit } from '../chain/burn.js';
import { prescriptionContentHash } from '../lib/hash.js';
import { getActiveKey } from '../db/signingKeys.js';
import { verifyDoctorSignature } from '../crypto/doctorSignature.js';
import { AppError, forbidden } from '../lib/errors.js';

const idParam = z.object({ id: z.string().uuid() });

const createBody = z.object({
  patient_id: z.string().uuid(),
  drug_details: z.object({
    drug: z.string().min(1),
    dosage: z.string().min(1),
    instructions: z.string().min(1),
    diagnosis: z.string().optional(),
  }),
  max_uses: z.number().int().min(1).max(50),
  // ISO-8601 UTC string, or null for a prescription that never expires.
  expires_at: z
    .string()
    .nullable()
    .refine((v) => v === null || !Number.isNaN(Date.parse(v)), {
      message: 'expires_at must be an ISO-8601 date string or null',
    }),
  /**
   * ECDSA P-256 signature (raw r‖s, base64) over the canonical JSON of the prescription
   * content, produced by the doctor's browser-held private key.
   *
   * Required. Making it optional would void the entire guarantee: a backend that can mint
   * without a signature is a backend that can forge prescriptions, which is exactly what
   * this field exists to prevent.
   */
  doctor_signature: z.string().min(1).max(200),
});

export async function prescriptionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Everything this doctor has prescribed, newest first, each with its patient and
   * chain event trail. `requireRole` rather than `requireVerifiedRole`: reading back
   * your own history isn't a privileged clinical act, and a doctor whose verification
   * lapsed should still be able to revoke what they wrote.
   */
  app.get('/doctor/prescriptions', { preHandler: requireRole('doctor') }, async (request) => {
    const prescriptions = await listForDoctor(request.auth!.id);
    return { prescriptions };
  });

  /**
   * Doctor writes a prescription -> mints the token.
   *
   * Order matters: the row is created first because its id becomes the on-chain asset
   * name. If the chain then refuses the mint, the row is removed again — an `active`
   * prescription with no backing token would be a phantom the pharmacy could try to
   * dispense.
   */
  app.post(
    '/prescriptions',
    { preHandler: requireVerifiedRole('doctor') },
    async (request, reply) => {
      const body = createBody.parse(request.body);
      const doctor = request.auth!;

      const expiresAt = body.expires_at;
      if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) {
        throw new AppError('VALIDATION_ERROR', 'expires_at must be in the future');
      }

      // Confirms the target exists AND is actually a patient.
      const patient = await loadPatient(body.patient_id);

      /**
       * The doctor's signature covers exactly the fields that define the prescription's
       * meaning — the same object that becomes the on-chain content hash, so the
       * signature and the hash can never describe different prescriptions.
       *
       * Verified BEFORE the row is written and long before the chain is touched: an
       * unsigned prescription must leave no trace at all, on-chain or off.
       */
      const content = {
        patient_id: patient.id,
        doctor_id: doctor.id,
        drug_details: body.drug_details,
        max_uses: body.max_uses,
        expires_at: expiresAt,
      };

      const signingKey = await getActiveKey(doctor.id);
      if (!signingKey) {
        throw new AppError(
          'DOCTOR_KEY_NOT_ENROLLED',
          'No signing key is enrolled for this doctor — set one up on this device first',
        );
      }

      const signatureValid = verifyDoctorSignature({
        content,
        signatureBase64: body.doctor_signature,
        publicKeyBase64: signingKey.public_key,
      });
      if (!signatureValid) {
        throw new AppError(
          'INVALID_DOCTOR_SIGNATURE',
          'Prescription signature did not verify against the enrolled signing key',
          { expected_fingerprint: signingKey.fingerprint },
        );
      }

      const contentHash = prescriptionContentHash(content);

      const row = await createPrescription({
        patient_id: patient.id,
        doctor_id: doctor.id,
        drug_details: body.drug_details,
        content_hash: contentHash,
        max_uses: body.max_uses,
        expires_at: expiresAt,
        doctor_signature: body.doctor_signature,
        signing_key_id: signingKey.id,
      });

      let mint;
      try {
        mint = await mintPrescriptionToken({
          prescriptionId: row.id,
          quantity: body.max_uses,
          contentHash,
          doctorSignature: body.doctor_signature,
          expiresAt: expiresAt === null ? null : new Date(expiresAt),
        });
      } catch (err) {
        await deletePrescription(row.id);
        throw err;
      }

      const updated = await attachMint(row.id, {
        policy_id: mint.policy_id,
        asset_name: mint.asset_name,
        tx_hash: mint.tx_hash,
      });

      await recordEvent({
        prescription_id: row.id,
        event_type: 'mint',
        actor_id: doctor.id,
        actor_role: 'doctor',
        tx_hash: mint.tx_hash,
      });

      request.log.info(
        { prescription: row.id, tx: mint.tx_hash, quantity: body.max_uses },
        'prescription minted',
      );

      return reply.status(201).send({
        ...updated,
        status: effectiveStatus(updated),
        patient: { id: patient.id, full_name: patient.full_name },
        signing_key_fingerprint: signingKey.fingerprint,
      });
    },
  );

  /**
   * Pharmacy dispenses one fill -> burns one unit.
   *
   * Everything is re-checked server-side first, so a client that offers an expired or
   * exhausted prescription is refused before we touch the chain. Even if that check
   * were bypassed, the ledger itself would reject the burn — the guarantee is
   * belt-and-braces by design.
   */
  app.post(
    '/prescriptions/:id/dispense',
    { preHandler: requireVerifiedRole('pharmacy') },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const pharmacy = request.auth!;

      const row = await getPrescription(id);
      assertDispensable(row);

      const burn = await burnPrescriptionUnit({
        policyId: row.policy_id!,
        assetName: row.asset_name!,
        expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
      });

      const updated = await consumeUse(row.id, row.uses_remaining);

      await recordEvent({
        prescription_id: row.id,
        event_type: 'burn',
        actor_id: pharmacy.id,
        actor_role: 'pharmacy',
        station_id: pharmacy.station_id,
        tx_hash: burn.tx_hash,
      });

      request.log.info(
        { prescription: row.id, tx: burn.tx_hash, remaining: updated.uses_remaining },
        'prescription dispensed',
      );

      return {
        ...updated,
        status: effectiveStatus(updated),
        burn_tx_hash: burn.tx_hash,
      };
    },
  );

  /**
   * Doctor revokes a prescription -> burns every remaining unit at once, so nothing
   * dispensable is left on-chain. Only the prescribing doctor may revoke.
   */
  app.post(
    '/prescriptions/:id/revoke',
    { preHandler: requireRole('doctor') },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const doctor = request.auth!;

      const row = await getPrescription(id);
      if (row.doctor_id !== doctor.id) {
        throw forbidden('Only the prescribing doctor may revoke this prescription');
      }
      if (row.status === 'revoked') {
        throw new AppError('PRESCRIPTION_REVOKED', 'This prescription is already revoked');
      }
      if (row.uses_remaining <= 0) {
        throw new AppError('PRESCRIPTION_EXHAUSTED', 'Nothing left to revoke');
      }

      let txHash: string | null = null;
      // An expired prescription is already unusable and its time-lock forbids any burn,
      // so revoking one is a database-only action.
      if (effectiveStatus(row) !== 'expired' && row.policy_id && row.asset_name) {
        const burn = await burnPrescriptionUnit({
          policyId: row.policy_id,
          assetName: row.asset_name,
          expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
          quantity: row.uses_remaining,
        });
        txHash = burn.tx_hash;
      }

      const updated = await markRevoked(row.id);

      await recordEvent({
        prescription_id: row.id,
        event_type: 'revoke',
        actor_id: doctor.id,
        actor_role: 'doctor',
        tx_hash: txHash,
      });

      request.log.info({ prescription: row.id, tx: txHash }, 'prescription revoked');

      return { ...updated, status: effectiveStatus(updated), burn_tx_hash: txHash };
    },
  );
}
