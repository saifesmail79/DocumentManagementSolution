/**
 * The application's single storage driver.
 *
 * One instance per process: the driver holds no per-request state, and building
 * a new one per upload would re-run the durability probe on every request.
 */

import { FilesystemDriver } from './filesystem-driver.js';
import { config } from '../config/index.js';
import { moduleLogger } from '../lib/logger.js';

export const storage = new FilesystemDriver({
  root: config.storage.root,
  tempDirName: config.storage.tempDirName,
  logger: moduleLogger('storage'),
});

export { StorageError } from './filesystem-driver.js';
