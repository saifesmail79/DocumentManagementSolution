/**
 * Application logger.
 *
 * Structured JSON in production so logs can be searched; pretty-printed in
 * development. Errors are serialized with their stack and `cause`, which matters
 * here because the storage layer chains causes (StorageError -> underlying ENOENT)
 * and losing the cause loses the actual reason a write failed.
 */

import { pino } from 'pino';
import { config } from '../config/index.js';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'password',
  '*.password',
  'body.password',
  'DB_PASSWORD',
];

export const logger = pino({
  level: config.logging.level,
  redact: { paths: redactPaths, censor: '[redacted]' },
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
  ...(config.logging.pretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

/** Child logger tagged with a subsystem name, e.g. logger.child({ module: 'storage' }). */
export function moduleLogger(name) {
  return logger.child({ module: name });
}
