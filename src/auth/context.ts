import type { FastifyRequest } from 'fastify';
import { db } from '../db/client.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from './verify.js';
import { sha256Hex } from '../lib/hash.js';
import { AppError } from '../lib/errors.js';

export type Role = 'patient' | 'doctor' | 'pharmacy';

export type Verification = {
  body: 'HPCSA' | 'SAPC';
  registration_number: string;
  status: 'pending' | 'verified' | 'rejected';
};

export type AuthContext = {
  id: string;
  role: Role;
  full_name: string;
  station_id: string | null;
  verification: Verification | null;
};

export type StationContext = {
  id: string;
  type: 'doctor' | 'pharmacy';
  label: string;
  owner_user_id: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
    station?: StationContext;
  }
}

/**
 * Loads the full identity for a user. Role lives in `profiles`, never in JWT claims —
 * so a user cannot escalate their role by crafting a token.
 */
export async function loadAuthContext(userId: string): Promise<AuthContext> {
  const { data: profile, error } = await db()
    .from('profiles')
    .select('id, role, full_name')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw new AppError('INTERNAL_ERROR', 'Failed to load profile');
  if (!profile) throw unauthorized('No profile for this account');

  const role = profile.role as Role;

  const [station, verification] = await Promise.all([
    loadStationId(userId),
    loadVerification(userId, role),
  ]);

  return {
    id: profile.id,
    role,
    full_name: profile.full_name,
    station_id: station,
    verification,
  };
}

async function loadStationId(userId: string): Promise<string | null> {
  const { data } = await db()
    .from('stations')
    .select('id')
    .eq('owner_user_id', userId)
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

async function loadVerification(userId: string, role: Role): Promise<Verification | null> {
  if (role === 'doctor') {
    const { data } = await db()
      .from('doctors')
      .select('hpcsa_number, verification_status')
      .eq('user_id', userId)
      .maybeSingle();
    if (!data) return null;
    return {
      body: 'HPCSA',
      registration_number: data.hpcsa_number,
      status: data.verification_status,
    };
  }

  if (role === 'pharmacy') {
    const { data } = await db()
      .from('pharmacies')
      .select('sapc_number, verification_status')
      .eq('user_id', userId)
      .maybeSingle();
    if (!data) return null;
    return {
      body: 'SAPC',
      registration_number: data.sapc_number,
      status: data.verification_status,
    };
  }

  return null; // patients have no regulator registration
}

/** preHandler: requires a valid Supabase session. */
export async function requireAuth(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw unauthorized('Missing Bearer token');
  }
  const userId = await verifyAccessToken(header.slice('Bearer '.length).trim());
  request.auth = await loadAuthContext(userId);
}

/** preHandler factory: requires a session AND one of the given roles. */
export function requireRole(...roles: Role[]) {
  return async function (request: FastifyRequest): Promise<void> {
    await requireAuth(request);
    if (!roles.includes(request.auth!.role)) {
      throw forbidden(`Requires role: ${roles.join(' or ')}`);
    }
  };
}

/**
 * preHandler factory: requires a verified practitioner. Minting and dispensing are
 * gated on regulator verification, not merely on having the right role.
 */
export function requireVerifiedRole(...roles: Role[]) {
  return async function (request: FastifyRequest): Promise<void> {
    await requireRole(...roles)(request);
    if (request.auth!.verification?.status !== 'verified') {
      throw forbidden('Practitioner is not verified');
    }
  };
}

/** preHandler: authenticates an IoT station via its X-Station-Key header. */
export async function requireStation(request: FastifyRequest): Promise<void> {
  const raw = request.headers['x-station-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key) throw new AppError('INVALID_STATION_KEY', 'Missing X-Station-Key header');

  // Look the station up by hash — the raw key is never stored.
  const { data, error } = await db()
    .from('stations')
    .select('id, type, label, owner_user_id')
    .eq('api_key_hash', sha256Hex(key))
    .maybeSingle();

  if (error) throw new AppError('INTERNAL_ERROR', 'Failed to load station');
  if (!data) throw new AppError('INVALID_STATION_KEY', 'Unknown station key');

  request.station = data as StationContext;
}
