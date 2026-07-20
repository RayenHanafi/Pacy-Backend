import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { config, requireConfig } from '../config.js';
import { db } from '../db/client.js';
import { unauthorized } from '../lib/errors.js';

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function remoteJwks() {
  if (!jwks) {
    const url = new URL(`${requireConfig('SUPABASE_URL')}/auth/v1/.well-known/jwks.json`);
    jwks = createRemoteJWKSet(url);
  }
  return jwks;
}

/**
 * Resolves a Supabase access token to a user id.
 *
 * This project signs JWTs asymmetrically (ECC P-256 / ES256), so there is no shared
 * HMAC secret to verify against — we fetch the project's public keys from JWKS and
 * verify locally (fast, cached by `jose`).
 *
 * If local verification fails for any reason — legacy HS256 project, key rotation,
 * an unexpected algorithm — we fall back to asking Supabase directly. That call is
 * authoritative, so a token only fails if it is genuinely invalid.
 */
export async function verifyAccessToken(token: string): Promise<string> {
  const local = await verifyLocally(token);
  if (local) return local;

  const { data, error } = await db().auth.getUser(token);
  if (error || !data.user) throw unauthorized('Invalid or expired session');
  return data.user.id;
}

async function verifyLocally(token: string): Promise<string | null> {
  const issuer = `${config.SUPABASE_URL}/auth/v1`;

  try {
    let payload: JWTPayload;

    if (config.SUPABASE_JWT_SECRET) {
      // Legacy HS256 project.
      const secret = new TextEncoder().encode(config.SUPABASE_JWT_SECRET);
      ({ payload } = await jwtVerify(token, secret, { issuer }));
    } else {
      ({ payload } = await jwtVerify(token, remoteJwks(), { issuer }));
    }

    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}
