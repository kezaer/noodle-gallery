import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { access, link, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { StorageCore } from 'src/cores/storage.core.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { UploadTransferRepository } from 'src/repositories/upload-transfer.repository.js';

export type LocalOriginal = { localPath: string; cleanup: () => Promise<void> };
export type VerifiedOriginal = { bytes: number; digest: string; stagePath: string | null };
export class InvalidOriginalError extends Error {}

@Injectable()
export class OriginalStageService {
  constructor(
    private transfers: UploadTransferRepository,
    private config: ConfigRepository,
  ) {}

  private get options() {
    return this.config.getEnv().transfer;
  }

  private get directory() {
    return this.options.stageDirectory ?? join(StorageCore.getMediaLocation(), 'original-stage');
  }

  async reserve(assetId: string, key: string, bytes: number): Promise<string | undefined> {
    if (!this.options.stageEnabled || bytes > this.options.stageMaxBytes) {
      return;
    }
    const token = randomUUID();
    const reserved = await this.transfers.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(1798000000)`.execute(tx);
      const rows = await tx
        .selectFrom('gallery_original_stage')
        .select(['assetId', 'bytes', 'retained', 'claimUntil'])
        .where((eb) => eb.or([eb('retained', '=', true), eb('claimUntil', '>', new Date())]))
        .execute();
      const used = rows.filter((row) => row.assetId !== assetId).reduce((sum, row) => sum + row.bytes, 0);
      if (used + bytes > this.options.stageMaxBytes) {
        return false;
      }
      const existing = await tx
        .selectFrom('gallery_original_stage')
        .selectAll()
        .where('assetId', '=', assetId)
        .forUpdate()
        .executeTakeFirst();
      if (existing?.claimUntil && existing.claimUntil > new Date()) {
        return false;
      }
      const record = {
        assetId,
        key,
        bytes,
        path: null,
        claimToken: token,
        claimUntil: new Date(Date.now() + 120_000),
        retained: false,
        expiresAt: new Date(Date.now() + this.options.stageMaxAgeSeconds * 1000),
      };
      await tx
        .insertInto('gallery_original_stage')
        .values(record)
        .onConflict((oc) => oc.column('assetId').doUpdateSet(record))
        .execute();
      return true;
    });
    return reserved ? token : undefined;
  }

  async verify(
    assetId: string,
    key: string,
    expected: { bytes: number; digest: string },
    reservedToken?: string,
  ): Promise<VerifiedOriginal> {
    const token = reservedToken ?? (await this.reserve(assetId, key, expected.bytes));
    const partial = token ? join(this.directory, `${assetId}-${token}.partial${extname(key)}`) : undefined;
    const published = token ? join(this.directory, `${assetId}-${token}${extname(key)}`) : undefined;
    let output;
    if (partial) {
      try {
        await mkdir(this.directory, { recursive: true });
        output = await open(partial, 'wx');
      } catch {
        await this.discard(assetId);
      }
    }
    const hash = createHash('sha1');
    let bytes = 0;
    const heartbeat = token
      ? setInterval(
          () =>
            void this.transfers.db
              .updateTable('gallery_original_stage')
              .set({ claimUntil: new Date(Date.now() + 120_000) })
              .where('assetId', '=', assetId)
              .where('claimToken', '=', token)
              .execute(),
          30_000,
        )
      : undefined;
    heartbeat?.unref();
    try {
      const { StorageService } = await import('./storage.service.js');
      const { stream } = await StorageService.resolveBackendForKey(key).get(key);
      for await (const chunk of stream) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.length;
        if (bytes > expected.bytes) {
          stream.destroy();
          throw new InvalidOriginalError('Original size does not match the upload intent');
        }
        hash.update(data);
        if (output) {
          try {
            await output.writeFile(data);
          } catch {
            await output.close().catch(() => {});
            output = undefined;
            if (partial) {
              await rm(partial, { force: true });
            }
            await this.discard(assetId);
          }
        }
      }
      const digest = hash.digest('hex');
      if (bytes !== expected.bytes || digest !== expected.digest.toLowerCase()) {
        throw new InvalidOriginalError('Original checksum or size does not match the upload intent');
      }
      let stagePath: string | null = null;
      if (output && partial && published && token) {
        await output.sync();
        await output.close();
        output = undefined;
        await rename(partial, published);
        const row = await this.transfers.db
          .updateTable('gallery_original_stage')
          .set({
            path: published,
            retained: true,
            claimToken: null,
            claimUntil: null,
          })
          .where('assetId', '=', assetId)
          .where('claimToken', '=', token)
          .returning('assetId')
          .executeTakeFirst();
        if (row) {
          stagePath = published;
        } else {
          await rm(published, { force: true });
        }
      }
      return { bytes, digest, stagePath };
    } catch (error) {
      await output?.close().catch(() => {});
      if (partial) {
        await rm(partial, { force: true });
      }
      await this.discard(assetId);
      throw error;
    } finally {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
    }
  }

  async adoptLegacy(assetId: string, key: string, bytes: number, localPath: string): Promise<boolean> {
    const token = await this.reserve(assetId, key, bytes);
    if (!token) {
      return false;
    }
    const path = join(this.directory, `${assetId}-${token}${extname(key)}`);
    try {
      await mkdir(this.directory, { recursive: true });
      await link(localPath, path);
      await this.transfers.db
        .updateTable('gallery_original_stage')
        .set({ path, retained: true, claimToken: null, claimUntil: null })
        .where('assetId', '=', assetId)
        .where('claimToken', '=', token)
        .execute();
      return true;
    } catch {
      await rm(path, { force: true });
      await this.discard(assetId);
      return false;
    }
  }

  async acquire(key: string): Promise<LocalOriginal | undefined> {
    if (!this.options?.stageEnabled) {
      return;
    }
    const pin = randomUUID();
    let stage = await this.transfers.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('gallery_original_stage')
        .selectAll()
        .where('key', '=', key)
        .forUpdate()
        .executeTakeFirst();
      if (!row || row.expiresAt < new Date()) {
        return;
      }
      const pending = await tx
        .selectFrom('gallery_upload_job')
        .select('token')
        .where('assetId', '=', row.assetId)
        .where('state', 'in', ['pending', 'accepted'])
        .executeTakeFirst();
      if (!row.path && !pending) {
        return;
      }
      await tx
        .insertInto('gallery_stage_pin')
        .values({ token: pin, assetId: row.assetId, expiresAt: new Date(Date.now() + 120_000) })
        .execute();
      return row;
    });
    if (!stage) {
      return;
    }
    const heartbeat = setInterval(
      () =>
        void this.transfers.db
          .updateTable('gallery_stage_pin')
          .set({ expiresAt: new Date(Date.now() + 120_000) })
          .where('token', '=', pin)
          .execute(),
      30_000,
    );
    heartbeat.unref();
    const release = async () => {
      clearInterval(heartbeat);
      await this.transfers.db.deleteFrom('gallery_stage_pin').where('token', '=', pin).execute();
    };
    try {
      for (;;) {
        if (stage.path) {
          try {
            await access(stage.path);
            return { localPath: stage.path, cleanup: release };
          } catch {
            await this.transfers.db
              .updateTable('gallery_original_stage')
              .set({ path: null, retained: false })
              .where('assetId', '=', stage.assetId)
              .execute();
          }
        }
        if (stage.claimUntil && stage.claimUntil > new Date()) {
          await setTimeout(100);
        } else {
          const asset = await this.transfers.db
            .selectFrom('asset')
            .select('checksum')
            .where('id', '=', stage.assetId)
            .executeTakeFirst();
          if (!asset) {
            await release();
            return;
          }
          const reservedToken = await this.reserve(stage.assetId, key, stage.bytes);
          if (!reservedToken) {
            const competing = await this.transfers.db
              .selectFrom('gallery_original_stage')
              .selectAll()
              .where('assetId', '=', stage.assetId)
              .executeTakeFirst();
            if (competing?.claimUntil && competing.claimUntil > new Date()) {
              stage = competing;
              continue;
            }
            await release();
            return;
          }
          const verified = await this.verify(
            stage.assetId,
            key,
            { bytes: stage.bytes, digest: asset.checksum.toString('hex') },
            reservedToken,
          );
          if (verified.stagePath) {
            return { localPath: verified.stagePath, cleanup: release };
          }
          await release();
          return;
        }
        const next = await this.transfers.db
          .selectFrom('gallery_original_stage')
          .selectAll()
          .where('assetId', '=', stage.assetId)
          .executeTakeFirst();
        if (!next) {
          await release();
          return;
        }
        stage = next;
      }
    } catch (error) {
      await release();
      throw error;
    }
  }

  async discard(assetId: string) {
    const row = await this.transfers.db.transaction().execute(async (tx) => {
      const existing = await tx
        .selectFrom('gallery_original_stage')
        .select('path')
        .where('assetId', '=', assetId)
        .forUpdate()
        .executeTakeFirst();
      await tx
        .updateTable('gallery_original_stage')
        .set({ path: null, retained: false, claimToken: null, claimUntil: null })
        .where('assetId', '=', assetId)
        .execute();
      return existing;
    });
    if (row?.path) {
      await rm(row.path, { force: true });
    }
  }
  async reconcile() {
    const db = this.transfers.db;
    await db.deleteFrom('gallery_stage_pin').where('expiresAt', '<', new Date()).execute();
    if (this.options?.stageEnabled) {
      const known = await db
        .selectFrom('gallery_original_stage')
        .select(['path', 'claimToken', 'claimUntil'])
        .execute();
      const paths = new Set(known.map((row) => row.path));
      const active = known.filter((row) => row.claimUntil && row.claimUntil > new Date()).map((row) => row.claimToken);
      for (const name of await readdir(this.directory).catch(() => [])) {
        const path = join(this.directory, name);
        if (paths.has(path) || active.some((token) => token && name.includes(token))) {
          continue;
        }
        const entry = await stat(path);
        if (entry.mtimeMs < Date.now() - 120_000) {
          await rm(path, { force: true });
        }
      }
    }
    const rows = await db
      .selectFrom('gallery_original_stage')
      .selectAll()
      .where('retained', '=', true)
      .limit(100)
      .execute();
    for (const stage of rows) {
      const path = await db.transaction().execute(async (tx) => {
        const current = await tx
          .selectFrom('gallery_original_stage')
          .selectAll()
          .where('assetId', '=', stage.assetId)
          .forUpdate()
          .executeTakeFirst();
        if (!current?.path) {
          return;
        }
        const pin = await tx
          .selectFrom('gallery_stage_pin')
          .select('token')
          .where('assetId', '=', stage.assetId)
          .where('expiresAt', '>', new Date())
          .executeTakeFirst();
        if (pin) {
          return;
        }
        const open = await tx
          .selectFrom('gallery_upload_job')
          .select('token')
          .where('assetId', '=', stage.assetId)
          .where('state', 'in', ['pending', 'accepted'])
          .executeTakeFirst();
        const started = await tx
          .selectFrom('gallery_upload_job')
          .select('token')
          .where('assetId', '=', stage.assetId)
          .executeTakeFirst();
        if ((open || !started) && current.expiresAt > new Date()) {
          return;
        }
        await tx
          .updateTable('gallery_original_stage')
          .set({ path: null, retained: false })
          .where('assetId', '=', stage.assetId)
          .execute();
        return current.path;
      });
      if (path) {
        await rm(path, { force: true });
      }
    }
  }
}
