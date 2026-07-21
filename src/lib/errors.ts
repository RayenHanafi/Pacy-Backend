/**
 * Typed application errors. Thrown anywhere; mapped to HTTP responses in exactly one
 * place (`src/server.ts` error handler) per the repo convention.
 */
export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'INVALID_QR_TOKEN'
  | 'INVALID_STATION_KEY'
  | 'PRESCRIPTION_EXPIRED'
  | 'PRESCRIPTION_EXHAUSTED'
  | 'PRESCRIPTION_REVOKED'
  | 'PRESCRIPTION_NOT_ACTIVE'
  | 'DOCTOR_KEY_NOT_ENROLLED'
  | 'INVALID_DOCTOR_SIGNATURE'
  | 'CHAIN_ERROR'
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  INVALID_QR_TOKEN: 422,
  INVALID_STATION_KEY: 401,
  PRESCRIPTION_EXPIRED: 409,
  PRESCRIPTION_EXHAUSTED: 409,
  PRESCRIPTION_REVOKED: 409,
  PRESCRIPTION_NOT_ACTIVE: 409,
  // Not an error the doctor caused — the client routes them to enrolment.
  DOCTOR_KEY_NOT_ENROLLED: 409,
  INVALID_DOCTOR_SIGNATURE: 422,
  CHAIN_ERROR: 502,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export const unauthorized = (m = 'Authentication required') =>
  new AppError('UNAUTHORIZED', m);
export const forbidden = (m = 'Not permitted') => new AppError('FORBIDDEN', m);
export const notFound = (m = 'Not found') => new AppError('NOT_FOUND', m);
export const chainError = (m: string, details?: unknown) =>
  new AppError('CHAIN_ERROR', m, details);
