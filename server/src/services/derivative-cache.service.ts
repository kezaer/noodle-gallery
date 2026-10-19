import { Injectable, OnModuleDestroy } from '@nestjs/common';
import AsyncLock from 'async-lock';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { FileHandle, chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetFileType } from 'src/enum.js';
import { StorageBackend } from 'src/interfaces/storage-backend.interface.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

export type DerivativeCacheKey = {
  assetId: string;
  path: string;
  type: AssetFileType.Thumbnail | AssetFileType.Preview;
  isEdited: boolean;
  updateId: string;
  size: AssetFileType;
  edited: boolean;
};

type CacheEntry = { path: string; bytes: number; pins: number };

@Injectable()
export class DerivativeCacheService implements OnModuleDestroy {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly fills = new Map<string, Promise<void>>();
  private readonly budget = new AsyncLock();
  private initialized?: Promise<boolean>;
  private owner?: FileHandle;
  private allocated = 0;
  private stopping = false;
  private readonly onExit = () => {
    if (this.owner) {
      try {
        rmSync(join(this.directory, '.owner'), { force: true });
      } catch {
        // A stale marker keeps the next process on the storage backend.
      }
    }
  };
  private readonly onTerm = () => this.onSignal('SIGTERM');
  private readonly onInterrupt = () => this.onSignal('SIGINT');

  constructor(
    private config: ConfigRepository,
    private logger: LoggingRepository,
  ) {}

  private get directory() {
    return this.config.getEnv().thumbnailCache.directory ?? join(StorageCore.getMediaLocation(), 'thumbnail-cache');
  }

  async open(
    key: DerivativeCacheKey,
    backend: StorageBackend,
  ): Promise<{ stream: Readable; length: number } | undefined> {
    if (!this.config.getEnv().thumbnailCache.enabled || this.stopping) {
      return;
    }
    this.initialized ??= this.initialize();
    if (!(await this.initialized)) {
      return;
    }

    const hash = createHash('sha256')
      .update(JSON.stringify([key.assetId, key.path, key.type, key.isEdited, key.updateId, key.size, key.edited]))
      .digest('hex');
    const cached = await this.read(hash);
    if (cached) {
      return cached;
    }

    let pending = this.fills.get(hash);
    if (!pending) {
      if (this.fills.size >= 4) {
        return;
      }
      pending = this.fill(hash, key.path, backend);
      this.fills.set(hash, pending);
    }
    try {
      await pending;
    } finally {
      if (this.fills.get(hash) === pending) {
        this.fills.delete(hash);
      }
    }
    return this.read(hash);
  }

  private async initialize(): Promise<boolean> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      this.owner = await open(join(this.directory, '.owner'), 'wx', 0o600);
      process.once('exit', this.onExit);
      process.once('SIGTERM', this.onTerm);
      process.once('SIGINT', this.onInterrupt);
      await this.owner.writeFile(String(process.pid));
      await chmod(this.directory, 0o700);

      const files = await readdir(this.directory);
      const ready = [];
      for (const name of files) {
        const path = join(this.directory, name);
        if (/^[\da-f]{64}-[\da-f-]+\.partial$/.test(name)) {
          await rm(path, { force: true });
        } else if (/^[\da-f]{64}\.cache$/.test(name)) {
          const stats = await lstat(path);
          if (!stats.isFile()) {
            await rm(path, { force: true });
            continue;
          }
          ready.push({ hash: name.slice(0, -6), path, bytes: stats.size, modified: stats.mtimeMs });
        }
      }
      for (const file of ready.sort((a, b) => a.modified - b.modified)) {
        this.entries.set(file.hash, { path: file.path, bytes: file.bytes, pins: 0 });
        this.allocated += file.bytes;
      }
      await this.makeRoom(0);
      return true;
    } catch (error) {
      this.logger.warn(`Thumbnail cache unavailable; using storage backend: ${String(error)}`);
      await this.releaseOwner().catch(() => {});
      return false;
    }
  }

  private async read(hash: string): Promise<{ stream: Readable; length: number } | undefined> {
    try {
      return await this.budget.acquire('bytes', async () => {
        const entry = this.entries.get(hash);
        if (!entry) {
          return;
        }
        let file;
        try {
          file = await open(entry.path, 'r');
          const stats = await file.stat();
          if (!stats.isFile() || stats.size !== entry.bytes) {
            throw new Error('Cache entry changed');
          }
          entry.pins++;
          this.entries.delete(hash);
          this.entries.set(hash, entry);
          const stream = file.createReadStream();
          stream.once('close', () => entry.pins--);
          return { stream, length: entry.bytes };
        } catch {
          await file?.close().catch(() => {});
          await this.remove(hash, entry);
        }
      });
    } catch {
      return;
    }
  }

  private async fill(hash: string, key: string, backend: StorageBackend): Promise<void> {
    const partial = join(this.directory, `${hash}-${randomUUID()}.partial`);
    const published = join(this.directory, `${hash}.cache`);
    let source: Readable | undefined;
    let output: FileHandle | undefined;
    let reserved = 0;
    let committed = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const object = await backend.get(key);
      source = object.stream;
      source.on('error', () => {});
      const length = object.length;
      if (length === undefined || !Number.isSafeInteger(length) || length < 0) {
        return;
      }
      const admitted = await this.budget.acquire('bytes', async () => {
        if (!(await this.makeRoom(length))) {
          return false;
        }
        this.allocated += length;
        reserved = length;
        return true;
      });
      if (!admitted) {
        return;
      }

      output = await open(partial, 'wx', 0o600);
      timeout = setTimeout(() => source?.destroy(new Error('Thumbnail cache fill timed out')), 30_000);
      timeout.unref();
      let bytes = 0;
      for await (const chunk of source) {
        if (!Buffer.isBuffer(chunk) || bytes + chunk.length > length) {
          throw new Error('Invalid derivative byte length');
        }
        await output.writeFile(chunk);
        bytes += chunk.length;
      }
      if (bytes !== length) {
        throw new Error('Incomplete derivative');
      }
      await output.close();
      output = undefined;
      await this.budget.acquire('bytes', async () => {
        await rename(partial, published);
        this.entries.set(hash, { path: published, bytes: length, pins: 0 });
        committed = true;
      });
    } catch (error) {
      this.logger.debug(`Thumbnail cache fill failed; using storage backend: ${String(error)}`);
    } finally {
      clearTimeout(timeout);
      source?.destroy();
      await output?.close().catch(() => {});
      if (!committed) {
        try {
          await rm(partial, { force: true });
          await this.budget.acquire('bytes', () => {
            this.allocated -= reserved;
          });
        } catch (error) {
          this.logger.warn(`Thumbnail cache partial retained within its byte reservation: ${String(error)}`);
        }
      }
    }
  }

  private async makeRoom(bytes: number): Promise<boolean> {
    const max = this.config.getEnv().thumbnailCache.maxBytes;
    if (bytes > max) {
      return false;
    }
    for (const [hash, entry] of this.entries) {
      if (this.allocated + bytes <= max) {
        break;
      }
      if (entry.pins === 0) {
        await this.remove(hash, entry);
      }
    }
    return this.allocated + bytes <= max;
  }

  private async remove(hash: string, entry: CacheEntry) {
    await rm(entry.path, { force: true });
    this.entries.delete(hash);
    this.allocated -= entry.bytes;
  }

  private async releaseOwner() {
    if (!this.owner) {
      return;
    }

    try {
      await this.owner.close();
      await rm(join(this.directory, '.owner'), { force: true });
    } finally {
      this.owner = undefined;
      process.removeListener('exit', this.onExit);
      process.removeListener('SIGTERM', this.onTerm);
      process.removeListener('SIGINT', this.onInterrupt);
    }
  }

  private onSignal(signal: 'SIGTERM' | 'SIGINT') {
    if (process.listenerCount(signal) !== 0) {
      return;
    }

    this.stopping = true;
    this.onExit();
    process.kill(process.pid, signal);
  }

  async onModuleDestroy() {
    this.stopping = true;
    await this.initialized;
    await Promise.all(this.fills.values());
    await this.releaseOwner().catch((error) =>
      this.logger.warn(`Thumbnail cache owner cleanup failed: ${String(error)}`),
    );
  }
}
