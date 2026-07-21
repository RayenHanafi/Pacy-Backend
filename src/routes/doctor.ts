import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/context.js';
import { enrolKey, getActiveKey } from '../db/signingKeys.js';

const enrolBody = z.object({
  /** SPKI DER, base64. Validated as an actual P-256 key by `enrolKey`. */
  public_key: z.string().min(1).max(1000),
});

export async function doctorRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Whether this doctor has a signing key, and which one.
   *
   * The frontend compares `fingerprint` against the key held in the browser: a mismatch
   * means the doctor is on a different device and must re-enrol before prescribing.
   */
  app.get('/doctor/signing-key', { preHandler: requireRole('doctor') }, async (request) => {
    const key = await getActiveKey(request.auth!.id);
    if (!key) return { enrolled: false };

    return {
      enrolled: true,
      fingerprint: key.fingerprint,
      public_key: key.public_key,
      enrolled_at: key.created_at,
    };
  });

  /**
   * Enrols this device's public key, replacing any previous one.
   *
   * `requireRole` rather than `requireVerifiedRole`: enrolment is account setup, not a
   * clinical act. Verification is still enforced where it matters — at minting.
   */
  app.post('/doctor/signing-key', { preHandler: requireRole('doctor') }, async (request, reply) => {
    const { public_key } = enrolBody.parse(request.body);
    const { key, replacedPrevious } = await enrolKey(request.auth!.id, public_key);

    request.log.info(
      { doctor: request.auth!.id, fingerprint: key.fingerprint, replacedPrevious },
      'doctor signing key enrolled',
    );

    return reply.status(201).send({
      fingerprint: key.fingerprint,
      enrolled_at: key.created_at,
      replaced_previous: replacedPrevious,
    });
  });
}
