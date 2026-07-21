import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ZodError, z } from 'zod';
import { config } from './config.js';
import { AppError } from './lib/errors.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { patientRoutes } from './routes/patient.js';
import { stationRoutes } from './routes/stations.js';
import { prescriptionRoutes } from './routes/prescriptions.js';
import { doctorRoutes } from './routes/doctor.js';

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      // Never let a secret reach the logs.
      redact: ['req.headers.authorization', 'req.headers["x-station-key"]'],
      transport:
        config.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
          : undefined,
    },
  });

  // The frontend is a separate origin (Vercel); the IoT stations are not browsers.
  await app.register(cors, { origin: true, credentials: true });

  // Treat an empty JSON body as `{}`. Endpoints like /dispense and /revoke take no
  // body, but browser fetch wrappers routinely send `Content-Type: application/json`
  // regardless — and Fastify's default parser rejects that combination outright.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      const raw = typeof body === 'string' ? body.trim() : '';
      if (raw === '') return done(null, {});
      try {
        done(null, JSON.parse(raw));
      } catch {
        done(new AppError('VALIDATION_ERROR', 'Malformed JSON body'), undefined);
      }
    },
  );

  // Single place where every error becomes an HTTP response.
  //
  // MUST be registered BEFORE the routes: Fastify child contexts capture the error
  // handler at registration time, so routes registered first would silently keep the
  // default handler and emit Fastify's own error shape instead of our envelope.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      request.log.warn({ code: error.code, msg: error.message }, 'handled error');
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: z.treeifyError(error),
        },
      });
    }

    // Fastify's own 4xx (bad JSON body, schema failures, etc.)
    const err = error as Error & { statusCode?: number };
    if (typeof err.statusCode === 'number' && err.statusCode < 500) {
      return reply.status(err.statusCode).send({
        error: { code: 'VALIDATION_ERROR', message: err.message },
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
    }),
  );

  await app.register(healthRoutes);
  await app.register(meRoutes);
  await app.register(patientRoutes);
  await app.register(stationRoutes);
  await app.register(prescriptionRoutes);
  await app.register(doctorRoutes);

  return app;
}

async function main() {
  const app = await buildServer();
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
