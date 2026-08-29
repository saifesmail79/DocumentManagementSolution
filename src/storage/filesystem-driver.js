/**
 * Filesystem storage driver — writes to a local path or a UNC/NAS share.
 *
 * The write sequence below is the load-bearing part of this file. Every step
 * prevents a specific failure, and swapping any two of them opens a window in
 * which a crash leaves a committed database row pointing at a file that does not
 * exist — a document visible in the UI that 404s on download. That is silent
 * corruption; the reverse (a file with no row) is a harmless orphan the sweep
 * collects. So: the file is fully durable BEFORE the caller commits its row.
 *
 * Operational prerequisites, both documented in docs/ARCHITECTURE.md:
 *   • UV_THREADPOOL_SIZE must be raised (64). Node defaults to 4 worker threads for
 *     file I/O; one stalled SMB session otherwise blocks file I/O process-wide and
 *     every user sees timeouts, not just the one uploading.
 *   • On a NAS, confirm the SMB server honours flush requests (Samba's
 *     `strict sync` has defaulted to yes since 4.7, but verify rather than assume).
 *     init() runs a live durability probe to check this.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink, rm, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import path from 'node:path';

import { assertSafeRelativePath } from './paths.js';

export class StorageError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, { cause });
    this.name = 'StorageError';
    this.code = code ?? 'storage_error';
  }
}

export class FilesystemDriver {
  /**
   * @param {object} options
   * @param {string} options.root absolute local or UNC path
   * @param {string} [options.tempDirName] subfolder for in-progress writes; must share the root's volume
   * @param {number} [options.ioTimeoutMs] abort a single file operation after this long
   * @param {import('pino').Logger} [options.logger]
   */
  constructor({ root, tempDirName = '.tmp', ioTimeoutMs = 120_000, logger } = {}) {
    if (!root) throw new TypeError('FilesystemDriver: root is required');
    this.root = root;
    this.tempDir = path.join(root, tempDirName);
    this.ioTimeoutMs = ioTimeoutMs;
    this.logger = logger ?? { info() {}, warn() {}, error() {}, debug() {} };
  }

  /** Resolves a relative path to an absolute one, refusing anything that escapes the root. */
  absolute(relativePath) {
    const safe = assertSafeRelativePath(relativePath);
    return path.join(this.root, ...safe.split('/'));
  }

  /**
   * Verifies the storage root is reachable and writable, and that the volume
   * actually honours flush requests. Call once at boot; refuse to start on failure.
   *
   * A Windows service cannot see mapped drive letters, so on-prem this is where a
   * misconfigured STORAGE_ROOT surfaces — at startup with a clear message, rather
   * than on the first user's upload.
   */
  async init() {
    try {
      await mkdir(this.tempDir, { recursive: true });
    } catch (cause) {
      throw new StorageError(
        `Storage root is not usable: ${this.root}. If this is a network location, use a UNC path ` +
          '(mapped drive letters are invisible to a Windows service) and confirm the service ' +
          `account has write permission. Underlying error: ${cause.message}`,
        { code: 'storage_root_unavailable', cause },
      );
    }

    await this.#probeDurability();
    this.logger.info({ root: this.root }, 'storage root ready');
  }

  /**
   * Writes a test file, flushes it, reads it back and compares hashes.
   *
   * This does not prove the far end survived a power cut — only a real power cut
   * does that — but it does catch an unwritable share, a full volume, and a
   * filesystem that silently mangles what it is given.
   */
  async #probeDurability() {
    const probePath = path.join(this.tempDir, `.probe-${randomUUID()}`);
    const payload = Buffer.from(`durability-probe-${randomUUID()}`, 'utf8');
    const expected = createHash('sha256').update(payload).digest('hex');

    let handle;
    try {
      handle = await open(probePath, 'w');
      await handle.write(payload);
      await handle.sync();
      await handle.close();
      handle = undefined;

      const readBack = createHash('sha256');
      for await (const chunk of createReadStream(probePath)) readBack.update(chunk);

      if (readBack.digest('hex') !== expected) {
        throw new StorageError(
          `Storage durability probe failed at ${this.root}: data read back did not match what was written.`,
          { code: 'storage_probe_mismatch' },
        );
      }
    } catch (cause) {
      if (cause instanceof StorageError) throw cause;
      throw new StorageError(`Storage durability probe failed at ${this.root}: ${cause.message}`, {
        code: 'storage_probe_failed',
        cause,
      });
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(probePath).catch(() => {});
    }
  }

  /**
   * Durably stores one file.
   *
   * @param {import('node:stream').Readable} source
   * @param {object} args
   * @param {string} args.relativePath destination, from buildRelativePath()
   * @param {number} [args.maxBytes] abort and clean up if the stream exceeds this
   * @returns {Promise<{ relativePath: string, sha256: string, bytes: number }>}
   */
  async put(source, { relativePath, maxBytes } = {}) {
    const safeRelative = assertSafeRelativePath(relativePath);
    const finalPath = this.absolute(safeRelative);
    // The temp file shares a volume with the destination, so the rename below is a
    // metadata operation rather than a cross-volume copy (which would not be atomic
    // and would fail with EXDEV).
    const tempPath = path.join(this.tempDir, `${randomUUID()}.part`);

    const hasher = createHash('sha256');
    let bytes = 0;
    let handle;

    try {
      await mkdir(path.dirname(finalPath), { recursive: true });
      handle = await open(tempPath, 'wx');

      for await (const chunk of source) {
        bytes += chunk.length;
        if (maxBytes !== undefined && bytes > maxBytes) {
          throw new StorageError(`Upload exceeds the maximum of ${maxBytes} bytes`, {
            code: 'upload_too_large',
          });
        }
        hasher.update(chunk);
        await handle.write(chunk);
      }

      if (bytes === 0) {
        throw new StorageError('Refusing to store a zero-byte file', { code: 'empty_upload' });
      }

      // Push the bytes out of OS (and SMB) buffers before anything observes the file
      // at its final name. Without this, a crash between rename and commit leaves a
      // named-but-empty file that looks valid to a later stat().
      await handle.sync();
      await handle.close();
      handle = undefined;

      await rename(tempPath, finalPath);

      // Confirm the destination really is what we just wrote. Catches a truncated
      // write and a rename that reported success without landing.
      const written = await stat(finalPath);
      if (written.size !== bytes) {
        throw new StorageError(
          `Post-write verification failed for ${safeRelative}: expected ${bytes} bytes, found ${written.size}`,
          { code: 'storage_verify_failed' },
        );
      }

      return { relativePath: safeRelative, sha256: hasher.digest('hex'), bytes };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      // Only ever remove the temp file we created ourselves. Never unlink finalPath:
      // if the rename raced another writer, that file belongs to them and deleting it
      // would destroy a document whose row is about to commit.
      await unlink(tempPath).catch(() => {});
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to store ${safeRelative}: ${error.message}`, {
        code: 'storage_write_failed',
        cause: error,
      });
    }
  }

  /**
   * Opens a read stream, optionally for a byte range.
   *
   * Range support is required, not optional: PDF.js fetches pages with Range
   * requests, and without it every viewer downloads the whole file before rendering.
   *
   * @param {string} relativePath
   * @param {{ start?: number, end?: number }} [range] inclusive byte offsets
   */
  createReadStream(relativePath, range = {}) {
    const absolute = this.absolute(relativePath);
    const options = {};
    if (Number.isInteger(range.start)) options.start = range.start;
    if (Number.isInteger(range.end)) options.end = range.end;
    return createReadStream(absolute, options);
  }

  /** @returns {Promise<{ size: number, mtime: Date }>} */
  async stat(relativePath) {
    const absolute = this.absolute(relativePath);
    try {
      const info = await stat(absolute);
      return { size: info.size, mtime: info.mtime };
    } catch (cause) {
      throw new StorageError(`File not found in storage: ${relativePath}`, {
        code: cause.code === 'ENOENT' ? 'not_found' : 'storage_stat_failed',
        cause,
      });
    }
  }

  async exists(relativePath) {
    try {
      await access(this.absolute(relativePath), FS.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Re-hashes a stored file and compares it with the expected digest.
   * Used by the integrity sweep and, for small files, before serving them.
   */
  async verify(relativePath, expectedSha256) {
    const hasher = createHash('sha256');
    const stream = this.createReadStream(relativePath);
    for await (const chunk of stream) hasher.update(chunk);
    const actual = hasher.digest('hex');
    return { ok: actual === expectedSha256, actual, expected: expectedSha256 };
  }

  /**
   * Removes a file. Callers must only reach here via the purge sweep, after the
   * grace period — never inline with a user's delete, which is a soft delete.
   */
  async remove(relativePath) {
    const absolute = this.absolute(relativePath);
    await rm(absolute, { force: true });
  }

  /** Clears abandoned .part files left by crashed uploads. */
  async cleanupTemp({ olderThanMs = 24 * 60 * 60 * 1000 } = {}) {
    const { readdir } = await import('node:fs/promises');
    let entries;
    try {
      entries = await readdir(this.tempDir);
    } catch {
      return { removed: 0 };
    }

    let removed = 0;
    const cutoff = Date.now() - olderThanMs;
    for (const entry of entries) {
      const full = path.join(this.tempDir, entry);
      try {
        const info = await stat(full);
        if (info.mtimeMs < cutoff) {
          await unlink(full);
          removed += 1;
        }
      } catch {
        // Raced with another cleanup or the file vanished — nothing to do.
      }
    }
    if (removed > 0) this.logger.info({ removed }, 'cleared abandoned temp uploads');
    return { removed };
  }
}
