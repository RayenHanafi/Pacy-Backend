import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, requireStation } from '../auth/context.js';
import { verifyQrToken } from '../qr/token.js';
import { buildScanContext, recordStationScan, takeCurrentScan } from '../db/scan.js';
import { forbidden } from '../lib/errors.js';

const scanBody = z.object({ qr_token: z.string().min(1) });

export async function stationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * IoT scanner → backend. The Raspberry Pi authenticates with its own station key,
   * posts the QR it just read, and the result is stashed for the operator's browser
   * to collect via GET /stations/current-scan.
   */
  app.post('/stations/scan', { preHandler: requireStation }, async (request) => {
    const { qr_token } = scanBody.parse(request.body);
    const patientId = verifyQrToken(qr_token);
    const station = request.station!;

    const scannedAt = await recordStationScan(station.id, patientId);
    return buildScanContext(patientId, station.type, scannedAt);
  });

  /**
   * Operator browser polls this while waiting for a patient to be scanned at its
   * station. 204 means "nobody scanned yet" — an ordinary state, not an error.
   */
  app.get(
    '/stations/current-scan',
    { preHandler: requireRole('doctor', 'pharmacy') },
    async (request, reply) => {
      const auth = request.auth!;
      if (!auth.station_id) throw forbidden('This account has no station assigned');

      const scan = await takeCurrentScan(auth.station_id);
      if (!scan) return reply.status(204).send();

      const stationType = auth.role === 'doctor' ? 'doctor' : 'pharmacy';
      return buildScanContext(scan.patient_id, stationType, scan.scanned_at);
    },
  );

  /**
   * Browser-camera fallback: no Raspberry Pi involved. The operator scans the QR with
   * their own webcam and posts it with their user JWT, getting the context inline.
   * This keeps the whole flow demoable from laptops alone.
   */
  app.post('/scan', { preHandler: requireRole('doctor', 'pharmacy') }, async (request) => {
    const { qr_token } = scanBody.parse(request.body);
    const patientId = verifyQrToken(qr_token);
    const auth = request.auth!;
    const stationType = auth.role === 'doctor' ? 'doctor' : 'pharmacy';

    // Mirror it into the station slot too, so a browser poll and a camera scan can't
    // disagree about who is currently at the counter.
    const scannedAt = auth.station_id
      ? await recordStationScan(auth.station_id, patientId)
      : new Date().toISOString();

    return buildScanContext(patientId, stationType, scannedAt);
  });
}
