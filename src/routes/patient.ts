import type { FastifyInstance } from 'fastify';
import { requireRole } from '../auth/context.js';
import { issueQrToken } from '../qr/token.js';
import { listForPatient } from '../db/prescriptions.js';

export async function patientRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The rotating identity QR. The client re-fetches shortly before `expires_in`
   * elapses so the displayed code is never actually dead on screen.
   */
  app.get('/patient/qr-token', { preHandler: requireRole('patient') }, async (request) => {
    const { token, expires_in } = issueQrToken(request.auth!.id);
    return {
      token,
      expires_in,
      expires_at: new Date(Date.now() + expires_in * 1000).toISOString(),
    };
  });

  /**
   * The patient's own prescription history, newest first, each with its chain event
   * trail. `status` is the effective status, so an expired-but-unswept row reads
   * `expired` rather than `active`.
   */
  app.get('/patient/prescriptions', { preHandler: requireRole('patient') }, async (request) => {
    const prescriptions = await listForPatient(request.auth!.id);
    return { prescriptions };
  });
}
