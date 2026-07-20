import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { config, requireConfig } from '../config.js';
import { AppError } from '../lib/errors.js';

type QrClaims = {
  sub: string; // patient id
  jti: string;
  iat: number;
  exp: number;
};

/**
 * Issues the patient's rotating identity QR token.
 *
 * Short-lived (30s by default) so a photographed or screenshotted QR is useless almost
 * immediately — this is what removes the "just copy the QR" attack without requiring
 * patients to hold blockchain keys.
 */
export function issueQrToken(patientId: string): { token: string; expires_in: number } {
  const ttl = config.QR_TOKEN_TTL_SECONDS;
  const token = jwt.sign({ jti: randomUUID() }, requireConfig('QR_TOKEN_SECRET'), {
    subject: patientId,
    expiresIn: ttl,
    algorithm: 'HS256',
  });
  return { token, expires_in: ttl };
}

/** Verifies a scanned QR token, returning the patient id. */
export function verifyQrToken(token: string): string {
  try {
    const claims = jwt.verify(token, requireConfig('QR_TOKEN_SECRET'), {
      algorithms: ['HS256'],
    }) as QrClaims;
    return claims.sub;
  } catch (err) {
    const expired = err instanceof jwt.TokenExpiredError;
    throw new AppError(
      'INVALID_QR_TOKEN',
      expired ? 'QR code has expired — ask the patient to refresh' : 'Invalid QR code',
    );
  }
}
