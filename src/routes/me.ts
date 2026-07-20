import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/context.js';

export async function meRoutes(app: FastifyInstance): Promise<void> {
  // Frozen shape — the frontend types against this. See ARCHITECTURE.md §8.
  app.get('/me', { preHandler: requireAuth }, async (request) => {
    const { id, role, full_name, station_id, verification } = request.auth!;
    return { id, role, full_name, station_id, verification };
  });
}
