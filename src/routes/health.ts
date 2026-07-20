import type { FastifyInstance } from 'fastify';
import { config, isConfigured } from '../config.js';

/**
 * Liveness + configuration visibility. Phase 7 upgrades this to actually ping Supabase
 * and Blockfrost; for now it reports which credentials are wired up, which is what we
 * need while the environment is still being filled in.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({
    status: 'ok',
    service: 'pacy-backend',
    network: config.CARDANO_NETWORK,
    env: config.NODE_ENV,
    uptime_s: Math.round(process.uptime()),
    configured: {
      supabase: isConfigured.supabase(),
      supabase_auth: isConfigured.supabaseAuth(),
      blockfrost: isConfigured.blockfrost(),
      service_wallet: isConfigured.wallet(),
      qr_token: isConfigured.qr(),
    },
    timestamp: new Date().toISOString(),
  }));
}
