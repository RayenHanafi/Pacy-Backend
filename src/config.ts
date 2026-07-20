import 'dotenv/config';
import { z } from 'zod';

/**
 * Secrets are declared optional here so the service can boot (and `/health` can report
 * what's missing) before every credential is filled in. Modules that actually need a
 * secret call `requireConfig()` and fail loudly at the point of use.
 */
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  SUPABASE_URL: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_JWT_SECRET: z.string().min(1).optional(),

  BLOCKFROST_PROJECT_ID: z.string().min(1).optional(),
  CARDANO_NETWORK: z.literal('preprod').default('preprod'),
  SERVICE_WALLET_MNEMONIC: z.string().min(1).optional(),

  QR_TOKEN_SECRET: z.string().min(1).optional(),
  QR_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(30),
});

/**
 * `FOO=` in a .env file yields an empty string, not `undefined` — which would fail the
 * optional `.min(1)` checks above. Treat blank as "not set" so a commented-out or
 * deliberately-empty variable (e.g. SUPABASE_JWT_SECRET on ES256 projects) is fine.
 */
const rawEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== undefined && value !== ''),
);

const parsed = schema.safeParse(rawEnv);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

/** Fetch a config value that must be present, throwing a clear error if it isn't. */
export function requireConfig<K extends keyof Config>(key: K): NonNullable<Config[K]> {
  const value = config[key];
  if (value === undefined || value === null || value === '') {
    throw new Error(
      `Missing required environment variable: ${String(key)}. See .env.example.`,
    );
  }
  return value as NonNullable<Config[K]>;
}

export const isConfigured = {
  supabase: () => Boolean(config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY),
  supabaseAuth: () => Boolean(config.SUPABASE_JWT_SECRET),
  blockfrost: () => Boolean(config.BLOCKFROST_PROJECT_ID),
  wallet: () => Boolean(config.SERVICE_WALLET_MNEMONIC),
  qr: () => Boolean(config.QR_TOKEN_SECRET),
};
