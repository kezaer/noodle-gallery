import { WorkflowTrigger } from '@immich/plugin-sdk';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { UploadSessionCreateSchema } from 'src/dtos/upload-session.dto.js';
import { AssetVisibility, ChecksumAlgorithm, JobName } from 'src/enum.js';
import {
  UploadProgress,
  UploadSession,
  uploadGraphJobs,
  uploadIsTerminal,
  uploadJobToken,
} from 'src/gallery/transfer.js';
import { TransferDatabase, VerifiedCommit } from 'src/gallery/transfer.schema.js';
import { JobItem } from 'src/types.js';
import { mimeTypes } from 'src/utils/mime-types.js';

@Injectable()
export class UploadTransferRepository {
  constructor(@InjectKysely() readonly db: Kysely<TransferDatabase>) {}

  async get(id: string): Promise<UploadSession | undefined> {
    const row = await this.db.selectFrom('gallery_upload_session').selectAll().where('id', '=', id).executeTakeFirst();
    return row && { ...row, intent: UploadSessionCreateSchema.parse(row.intent) };
  }

  async create(session: UploadSession) {
    await this.db.transaction().execute(async (tx) => {
      await this.reserve(tx, session.id, session.ownerId, session.intent.size, session.expiresAt);
      await tx
        .insertInto('gallery_upload_session')
        .values({
          ...session,
          intent: session.intent,
          progress: session.progress,
        })
        .execute();
    });
  }

  private async reserve(tx: Kysely<TransferDatabase>, id: string, ownerId: string, bytes: number, expiresAt: Date) {
    const user = await tx
      .selectFrom('user')
      .select(['quotaSizeInBytes', 'quotaUsageInBytes'])
      .where('id', '=', ownerId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const { reserved } = await tx
      .selectFrom('gallery_upload_reservation')
      .select(sql<number>`coalesce(sum(bytes), 0)`.as('reserved'))
      .where('ownerId', '=', ownerId)
      .where('expiresAt', '>', new Date())
      .executeTakeFirstOrThrow();
    if (user.quotaSizeInBytes !== null && user.quotaUsageInBytes + Number(reserved) + bytes > user.quotaSizeInBytes) {
      throw new BadRequestException('Quota has been exceeded!');
    }
    await tx.insertInto('gallery_upload_reservation').values({ id, ownerId, bytes, expiresAt }).execute();
  }

  async reserveLegacy(ownerId: string, bytes: number) {
    const id = randomUUID();
    await this.db
      .transaction()
      .execute((tx) => this.reserve(tx, id, ownerId, bytes, new Date(Date.now() + 86_400_000)));
    return id;
  }

  async releaseReservation(id: string) {
    await this.db.deleteFrom('gallery_upload_reservation').where('id', '=', id).execute();
  }

  async accountLegacy(id: string, ownerId: string, bytes: number) {
    await this.db.transaction().execute(async (tx) => {
      await tx.selectFrom('user').select('id').where('id', '=', ownerId).forUpdate().executeTakeFirstOrThrow();
      const reservation = await tx
        .deleteFrom('gallery_upload_reservation')
        .where('id', '=', id)
        .returning('id')
        .executeTakeFirst();
      if (reservation) {
        await tx
          .updateTable('user')
          .set({ quotaUsageInBytes: sql`"quotaUsageInBytes" + ${bytes}` })
          .where('id', '=', ownerId)
          .execute();
      }
    });
  }

  async update(id: string, progress: UploadProgress, claimToken?: string) {
    const query = this.db
      .updateTable('gallery_upload_session')
      .set({ progress, updatedAt: new Date() })
      .where('id', '=', id);
    return (claimToken ? query.where('claimToken', '=', claimToken) : query).executeTakeFirst();
  }

  async requestComplete(id: string) {
    await this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('gallery_upload_session')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (row.progress.kind === 'uploading') {
        await tx
          .updateTable('gallery_upload_session')
          .set({
            progress: { kind: 'finalizing', uploadId: row.progress.uploadId, manifest: [] },
            updatedAt: new Date(),
          })
          .where('id', '=', id)
          .execute();
      }
    });
  }

  async requestCancel(id: string) {
    await this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('gallery_upload_session')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (!uploadIsTerminal(row.progress)) {
        await tx.updateTable('gallery_upload_session').set({ cancelRequested: true }).where('id', '=', id).execute();
      }
    });
  }

  async pending() {
    const rows = await this.db
      .selectFrom('gallery_upload_session')
      .select('id')
      .where((eb) =>
        eb.or([
          eb(sql`progress->>'kind'`, 'in', ['initiating', 'finalizing', 'verifying', 'verified']),
          eb.and([eb(sql`progress->>'kind'`, '=', 'committed'), eb('eventDelivered', '=', false)]),
          eb(sql`progress->>'cleanup'`, '=', 'pending'),
          eb(sql`progress->'cleanup'->>'kind'`, '=', 'pending'),
          eb.and([
            eb(sql`progress->>'kind'`, '=', 'uploading'),
            eb.or([eb('cancelRequested', '=', true), eb('expiresAt', '<', new Date())]),
          ]),
        ]),
      )
      .orderBy('updatedAt')
      .limit(20)
      .execute();
    return rows.map((row) => row.id);
  }

  async claim(id: string) {
    const claimToken = randomUUID();
    const row = await this.db
      .updateTable('gallery_upload_session')
      .set({ claimToken, claimUntil: new Date(Date.now() + 120_000) })
      .where('id', '=', id)
      .where((eb) => eb.or([eb('claimUntil', 'is', null), eb('claimUntil', '<', new Date())]))
      .returning('id')
      .executeTakeFirst();
    return row ? claimToken : undefined;
  }

  async renew(id: string, token: string) {
    await this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable('gallery_upload_session')
        .set({ claimUntil: new Date(Date.now() + 120_000) })
        .where('id', '=', id)
        .where('claimToken', '=', token)
        .execute();
      await tx
        .updateTable('gallery_upload_reservation')
        .set({ expiresAt: new Date(Date.now() + 120_000) })
        .where('id', '=', id)
        .execute();
    });
  }

  async releaseClaim(id: string, token: string) {
    await this.db
      .updateTable('gallery_upload_session')
      .set({ claimToken: null, claimUntil: null })
      .where('id', '=', id)
      .where('claimToken', '=', token)
      .execute();
  }

  async commit(id: string, token: string, stageMaxAgeSeconds: number): Promise<VerifiedCommit | undefined> {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('gallery_upload_session')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (row.progress.kind === 'committed' || row.progress.kind === 'duplicate') {
        return { response: row.progress.result, claimed: row.progress.kind === 'committed' };
      }
      if (row.claimToken !== token || row.cancelRequested || row.progress.kind !== 'verified') {
        return;
      }
      const intent = UploadSessionCreateSchema.parse(row.intent);
      const user = await tx
        .selectFrom('user')
        .select(['quotaSizeInBytes', 'quotaUsageInBytes'])
        .where('id', '=', row.ownerId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const checksum = Buffer.from(row.progress.digest, 'hex');
      const duplicate = await tx
        .selectFrom('asset')
        .select('id')
        .where('ownerId', '=', row.ownerId)
        .where('libraryId', 'is', null)
        .where('checksum', '=', checksum)
        .executeTakeFirst();
      const tombstone = duplicate
        ? undefined
        : await tx
            .selectFrom('asset_duplicate_checksum')
            .select('assetId')
            .where('ownerId', '=', row.ownerId)
            .where('checksum', '=', checksum)
            .executeTakeFirst();
      let assetId = duplicate?.id ?? tombstone?.assetId;
      if (!assetId) {
        const { reserved } = await tx
          .selectFrom('gallery_upload_reservation')
          .select(sql<number>`coalesce(sum(bytes), 0)`.as('reserved'))
          .where('ownerId', '=', row.ownerId)
          .where('id', '!=', id)
          .where('expiresAt', '>', new Date())
          .executeTakeFirstOrThrow();
        if (
          user.quotaSizeInBytes !== null &&
          user.quotaUsageInBytes + Number(reserved) + row.progress.bytes > user.quotaSizeInBytes
        ) {
          throw new BadRequestException('Quota has been exceeded!');
        }
        const asset = await tx
          .insertInto('asset')
          .values({
            id: row.assetId,
            ownerId: row.ownerId,
            libraryId: null,
            checksum,
            checksumAlgorithm: ChecksumAlgorithm.sha1File,
            originalPath: row.key,
            fileCreatedAt: intent.fileCreatedAt,
            fileModifiedAt: intent.fileModifiedAt,
            localDateTime: intent.fileCreatedAt,
            type: mimeTypes.assetType(row.key),
            duration: intent.duration || null,
            visibility: intent.visibility ?? AssetVisibility.Timeline,
            originalFileName: intent.filename,
          })
          .onConflict((oc) => oc.doNothing())
          .returning('id')
          .executeTakeFirst();
        if (asset) {
          await tx
            .insertInto('asset_exif')
            .values({ assetId: row.assetId, fileSizeInByte: row.progress.bytes })
            .execute();
          if (intent.isFavorite) {
            await tx.insertInto('asset_favorite').values({ userId: row.ownerId, assetId: row.assetId }).execute();
          }
          if (intent.metadata?.length) {
            await tx
              .insertInto('asset_metadata')
              .values(intent.metadata.map((item) => ({ ...item, assetId: row.assetId })))
              .execute();
          }
          await tx
            .updateTable('user')
            .set({ quotaUsageInBytes: sql`"quotaUsageInBytes" + ${row.progress.bytes}` })
            .where('id', '=', row.ownerId)
            .execute();
          await tx
            .insertInto('gallery_original_stage')
            .values({
              assetId: row.assetId,
              key: row.key,
              bytes: row.progress.bytes,
              path: row.progress.stagePath,
              claimToken: null,
              claimUntil: null,
              retained: row.progress.stagePath !== null,
              expiresAt: new Date(Date.now() + stageMaxAgeSeconds * 1000),
            })
            .onConflict((oc) => oc.column('assetId').doNothing())
            .execute();
          const item: JobItem = { name: JobName.AssetExtractMetadata, data: { id: row.assetId, source: 'upload' } };
          await tx
            .insertInto('gallery_upload_job')
            .values({
              token: uploadJobToken(row.assetId, item),
              assetId: row.assetId,
              item,
              state: 'pending',
            })
            .execute();
        } else {
          const existing = await tx
            .selectFrom('asset')
            .select('id')
            .where('ownerId', '=', row.ownerId)
            .where('libraryId', 'is', null)
            .where('checksum', '=', checksum)
            .executeTakeFirstOrThrow();
          assetId = existing.id;
        }
      }
      const claimed = !assetId;
      const response = {
        id: assetId ?? row.assetId,
        status: claimed ? AssetMediaStatus.CREATED : AssetMediaStatus.DUPLICATE,
      };
      await tx.deleteFrom('gallery_upload_reservation').where('id', '=', id).execute();
      await tx
        .updateTable('gallery_upload_session')
        .set({
          progress: claimed
            ? { kind: 'committed', result: response }
            : { kind: 'duplicate', result: response, cleanup: 'pending' },
          updatedAt: new Date(),
        })
        .where('id', '=', id)
        .execute();
      return { response, claimed };
    });
  }

  async snapshotWorkflows(assetId: string, ownerId: string) {
    await this.db.transaction().execute(async (tx) => {
      const session = await tx
        .selectFrom('gallery_upload_session')
        .select(['id', 'workflowsSnapshotted'])
        .where('assetId', '=', assetId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (session.workflowsSnapshotted) {
        return;
      }
      const workflows = await tx
        .selectFrom('workflow')
        .select('id')
        .where('ownerId', '=', ownerId)
        .where('trigger', '=', WorkflowTrigger.AssetCreate)
        .where('enabled', '=', true)
        .execute();
      if (workflows.length > 0) {
        await tx
          .insertInto('gallery_upload_workflow')
          .values(workflows.map(({ id }) => ({ assetId, workflowId: id })))
          .execute();
      }
      await tx
        .updateTable('gallery_upload_session')
        .set({ workflowsSnapshotted: true })
        .where('id', '=', session.id)
        .execute();
    });
    return this.db
      .selectFrom('gallery_upload_workflow')
      .selectAll()
      .where('assetId', '=', assetId)
      .where('accepted', '=', false)
      .execute();
  }
  async registerJobs(items: JobItem[], parentAssetId?: string) {
    const registrations = new Map<string, string>();
    await this.db.transaction().execute(async (tx) => {
      for (const item of items) {
        if (!uploadGraphJobs.has(item.name)) {
          continue;
        }
        const data = item.data;
        const rootAssetId =
          data && 'source' in data && data.source === 'upload' && 'id' in data && typeof data.id === 'string'
            ? data.id
            : undefined;
        const assetId = parentAssetId ?? rootAssetId;
        if (!assetId) {
          continue;
        }
        const stage = await tx
          .selectFrom('gallery_original_stage')
          .select('assetId')
          .where('assetId', '=', assetId)
          .forUpdate()
          .executeTakeFirst();
        if (!stage) {
          continue;
        }
        const token = uploadJobToken(assetId, item);
        await tx
          .insertInto('gallery_upload_job')
          .values({ token, assetId, item, state: 'pending' })
          .onConflict((oc) => oc.column('token').doNothing())
          .execute();
        registrations.set(JSON.stringify(item), token);
      }
    });
    return registrations;
  }

  async pendingJobs() {
    return this.db
      .selectFrom('gallery_upload_job')
      .selectAll()
      .where('state', 'in', ['pending', 'accepted'])
      .orderBy('updatedAt')
      .limit(100)
      .execute();
  }

  async startJob(token: string) {
    return this.db
      .updateTable('gallery_upload_job')
      .set({ attempts: sql`attempts + 1`, updatedAt: new Date() })
      .where('token', '=', token)
      .where('state', 'in', ['pending', 'accepted'])
      .returningAll()
      .executeTakeFirst();
  }

  async finishJob(token: string, state: 'success' | 'skipped' | 'failed' | 'accepted') {
    const query = this.db
      .updateTable('gallery_upload_job')
      .set({ state, updatedAt: new Date() })
      .where('token', '=', token);
    await (state === 'accepted' ? query.where('state', 'in', ['pending', 'accepted']) : query).execute();
  }
}
