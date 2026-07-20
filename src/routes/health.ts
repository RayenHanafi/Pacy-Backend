import type { FastifyInstance } from 'fastify';
import { config, isConfigured } from '../config.js';
import { db } from '../db/client.js';

type Check = { ok: boolean; latency_ms: number; detail?: string };

const CHECK_TIMEOUT_MS = 4000;

/**
 * Runs a dependency check under a hard deadline.
 *
 * A health endpoint that can hang is worse than no health endpoint: Railway's probe
 * would sit open and the deploy would look stalled rather than failed.
 */
async function timed(fn: (signal: AbortSignal) => Promise<void>): Promise<Check> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    await fn(controller.signal);
    return { ok: true, latency_ms: Date.now() - started };
  } catch (err) {
    const detail =
      controller.signal.aborted
        ? `timed out after ${CHECK_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, latency_ms: Date.now() - started, detail };
  } finally {
    clearTimeout(timer);
  }
}

async function checkSupabase(): Promise<Check> {
  return timed(async () => {
    // Cheapest possible round-trip that still proves credentials work: a count, no rows.
    const { error } = await db().from('profiles').select('id', { count: 'exact', head: true });
    if (error) throw new Error(error.message);
  });
}

async function checkBlockfrost(): Promise<Check> {
  return timed(async (signal) => {
    const res = await fetch('https://cardano-preprod.blockfrost.io/api/v0/blocks/latest', {
      headers: { project_id: config.BLOCKFROST_PROJECT_ID! },
      signal,
    });
    if (!res.ok) throw new Error(`Blockfrost returned ${res.status}`);
  });
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Liveness + dependency status.
   *
   * Deliberately always returns 200 when the process is alive, even when a dependency
   * is down — `status` carries the verdict instead. Railway restarts a service whose
   * health check fails, and restarting the API because *Blockfrost* is having a bad
   * minute would turn a partial outage into a total one.
   */
  app.get('/health', async () => {
    const [supabase, blockfrost] = await Promise.all([
      isConfigured.supabase() ? checkSupabase() : Promise.resolve(undefined),
      isConfigured.blockfrost() ? checkBlockfrost() : Promise.resolve(undefined),
    ]);

    const checks = { supabase, blockfrost };
    const ran = Object.values(checks).filter((c): c is Check => c !== undefined);
    const healthy = ran.length > 0 && ran.every((c) => c.ok);

    return {
      status: healthy ? 'ok' : 'degraded',
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
      checks,
      timestamp: new Date().toISOString(),
    };
  });

  /** Bare liveness for uptime pings — no dependency calls, no cost. */
  app.get('/health/live', async () => ({ status: 'ok' }));
}
