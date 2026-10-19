import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { S3StorageBackend } from 'src/backends/s3-storage.backend.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { UploadSessionCreateDto, UploadSessionResponseDto } from 'src/dtos/upload-session.dto.js';
import { StorageFolder } from 'src/enum.js';
import { UploadSession, uploadIsTerminal, validatePartManifest } from 'src/gallery/transfer.js';
import { StoredPart } from 'src/interfaces/s3-multipart.interface.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UploadTransferRepository } from 'src/repositories/upload-transfer.repository.js';
import { InvalidOriginalError, OriginalStageService } from 'src/services/original-stage.service.js';
import { StorageService } from 'src/services/storage.service.js';
import { getFilenameExtension } from 'src/utils/file.js';
import { mimeTypes } from 'src/utils/mime-types.js';

@Injectable()
export class UploadSessionService implements OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  constructor(
    private transfers: UploadTransferRepository,
    private config: ConfigRepository,
    private stages: OriginalStageService,
    private events: EventRepository,
    private jobs: JobRepository,
    private logger: LoggingRepository,
  ) {}

  private backend() {
    const backend = StorageService.getWriteBackend();
    if (!(backend instanceof S3StorageBackend)) {
      throw new BadRequestException('Direct upload requires S3 storage');
    }
    return backend;
  }

  async create(auth: AuthDto, intent: UploadSessionCreateDto): Promise<UploadSessionResponseDto> {
    if (!this.config.getEnv().transfer.directUploadEnabled || auth.sharedLink) {
      throw new BadRequestException('Direct upload is disabled for this request');
    }
    if (!mimeTypes.isAsset(intent.filename)) {
      throw new BadRequestException('Unsupported file type');
    }
    const backend = this.backend();
    const id = randomUUID();
    const assetId = randomUUID();
    const key = StorageCore.getRelativeNestedPath(
      StorageFolder.Upload,
      auth.user.id,
      `${assetId}${getFilenameExtension(intent.filename)}`,
    );
    const session: UploadSession = {
      id,
      assetId,
      ownerId: auth.user.id,
      key,
      intent,
      progress: { kind: 'initiating' },
      partSize: Math.max(16 * 1024 ** 2, Math.ceil(intent.size / 10_000 / 1024 ** 2) * 1024 ** 2),
      expiresAt: new Date(Date.now() + this.config.getEnv().transfer.sessionMaxAgeSeconds * 1000),
      claimToken: null,
      claimUntil: null,
      cancelRequested: false,
      eventDelivered: false,
      updatedAt: new Date(),
    };
    await this.transfers.create(session);
    try {
      const uploadId = await backend.startMultipart(key, mimeTypes.lookup(intent.filename));
      await this.transfers.update(id, { kind: 'uploading', uploadId });
    } catch (error) {
      await this.transfers.update(id, {
        kind: 'rejected',
        error: 'Unable to initiate multipart upload',
        cleanup: { kind: 'done' },
      });
      await this.transfers.releaseReservation(id);
      throw error;
    }
    return this.status(auth, id);
  }

  private async owned(auth: AuthDto, id: string) {
    const session = await this.transfers.get(id);
    if (!session || session.ownerId !== auth.user.id || auth.sharedLink) {
      throw new NotFoundException('Upload session not found');
    }
    return session;
  }

  async status(auth: AuthDto, id: string): Promise<UploadSessionResponseDto> {
    const session = await this.owned(auth, id);
    const { progress, intent } = session;
    let parts: StoredPart[] = [];
    if (progress.kind === 'uploading' && !session.cancelRequested && session.expiresAt > new Date()) {
      parts = await this.backend().listMultipartParts(session.key, progress.uploadId);
    }
    return {
      id,
      state: progress.kind,
      filename: intent.filename,
      size: intent.size,
      checksum: intent.checksum,
      partSize: session.partSize,
      expiresAt: session.expiresAt.toISOString(),
      parts,
      ...('result' in progress && { result: progress.result }),
      ...('error' in progress && { error: progress.error }),
    };
  }

  async signParts(auth: AuthDto, id: string, numbers: number[]) {
    const session = await this.owned(auth, id);
    if (session.progress.kind !== 'uploading' || session.cancelRequested || session.expiresAt <= new Date()) {
      throw new BadRequestException('Upload session is not open');
    }
    const count = Math.ceil(session.intent.size / session.partSize);
    if (numbers.some((number) => number > count) || new Set(numbers).size !== numbers.length) {
      throw new BadRequestException('Invalid multipart part numbers');
    }
    return {
      parts: await this.backend().signMultipartParts(
        session.key,
        session.progress.uploadId,
        numbers,
        this.config.getEnv().transfer.partUrlTtlSeconds,
      ),
    };
  }

  async complete(auth: AuthDto, id: string) {
    const session = await this.owned(auth, id);
    if (session.expiresAt <= new Date() && !uploadIsTerminal(session.progress)) {
      await this.transfers.requestCancel(id);
    } else {
      await this.transfers.requestComplete(id);
    }
    void this.reconcile();
    return this.status(auth, id);
  }

  async abort(auth: AuthDto, id: string) {
    await this.owned(auth, id);
    await this.transfers.requestCancel(id);
    void this.reconcile();
  }

  @OnEvent({ name: 'AppBootstrap' })
  onBootstrap() {
    if (this.config.getEnv().storage.backend !== 's3') {
      return;
    }
    this.timer = setInterval(() => void this.reconcile(), 5000);
    this.timer.unref();
    void this.reconcile();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async reconcile() {
    if (this.running) {
      return this.running;
    }
    this.running = this.runReconciliation();
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }

  private async runReconciliation() {
    try {
      await this.jobs.reconcileUploadJobs();
      await this.stages.reconcile();
      for (const id of await this.transfers.pending()) {
        const token = await this.transfers.claim(id);
        if (!token) {
          continue;
        }
        const heartbeat = setInterval(
          () => void this.transfers.renew(id, token).catch((error) => this.logger.error(error)),
          30_000,
        );
        heartbeat.unref();
        try {
          await this.advance(id, token);
        } catch (error) {
          this.logger.error(`Upload session ${id} could not advance`, error);
        } finally {
          clearInterval(heartbeat);
          await this.transfers.releaseClaim(id, token);
        }
      }
    } catch (error) {
      this.logger.error('Upload session reconciliation failed', error);
    }
  }

  private async reject(
    session: UploadSession,
    token: string,
    error: string,
    kind: 'rejected' | 'aborted' | 'expired' = 'rejected',
  ) {
    const changed = await this.transfers.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('gallery_upload_session')
        .selectAll()
        .where('id', '=', session.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (row.claimToken !== token || uploadIsTerminal(row.progress)) {
        return false;
      }
      const progress: UploadSession['progress'] = {
        kind,
        error,
        cleanup: { kind: 'pending', uploadId: 'uploadId' in row.progress ? row.progress.uploadId : null },
      };
      await tx
        .updateTable('gallery_upload_session')
        .set({ progress, updatedAt: new Date() })
        .where('id', '=', row.id)
        .execute();
      await tx.deleteFrom('gallery_upload_reservation').where('id', '=', row.id).execute();
      return true;
    });
    if (!changed) {
      return;
    }
    const current = await this.transfers.get(session.id);
    if (current) {
      await this.cleanupRejected(current, token);
    }
  }

  private async cleanupRejected(session: UploadSession, token: string) {
    const progress = session.progress;
    if (progress.kind === 'committed' || !('cleanup' in progress)) {
      return;
    }
    if (typeof progress.cleanup === 'object' && progress.cleanup.kind === 'pending' && progress.cleanup.uploadId) {
      await this.backend().abortMultipart(session.key, progress.cleanup.uploadId);
    }
    await this.backend().delete(session.key);
    await this.stages.discard(session.assetId, { kind: 'uncommitted' });
    await this.transfers.update(
      session.id,
      progress.kind === 'duplicate' ? { ...progress, cleanup: 'done' } : { ...progress, cleanup: { kind: 'done' } },
      token,
    );
  }

  private async advance(id: string, token: string) {
    let session = await this.transfers.get(id);
    if (!session) {
      return;
    }
    if (uploadIsTerminal(session.progress) && session.progress.kind !== 'committed') {
      await this.cleanupRejected(session, token);
      return;
    }
    if (
      !uploadIsTerminal(session.progress) &&
      (session.cancelRequested ||
        (['initiating', 'uploading'].includes(session.progress.kind) && session.expiresAt < new Date()))
    ) {
      await this.reject(session, token, 'Upload cancelled or expired', session.cancelRequested ? 'aborted' : 'expired');
      return;
    }
    if (session.progress.kind === 'initiating') {
      if (session.updatedAt < new Date(Date.now() - 120_000)) {
        await this.reject(session, token, 'Multipart initiation did not finish');
      }
      return;
    }
    if (session.progress.kind === 'finalizing') {
      let manifest = session.progress.manifest;
      if (manifest.length === 0) {
        manifest = await this.backend().listMultipartParts(session.key, session.progress.uploadId);
        if (!validatePartManifest(manifest, session.intent.size, session.partSize)) {
          await this.reject(session, token, 'Multipart upload is incomplete or has invalid part sizes');
          return;
        }
        await this.transfers.update(id, { ...session.progress, manifest }, token);
      }
      try {
        await this.backend().completeMultipart(session.key, session.progress.uploadId, manifest);
      } catch (error) {
        const object = await this.backend().headObject(session.key);
        if (!object) {
          throw error;
        }
      }
      await this.transfers.update(id, { kind: 'verifying', uploadId: session.progress.uploadId, manifest }, token);
      session = (await this.transfers.get(id))!;
    }
    if (session.progress.kind === 'verifying') {
      try {
        const verified = await this.stages.verify(session.assetId, session.key, {
          bytes: session.intent.size,
          digest: session.intent.checksum,
        });
        await this.transfers.update(id, { kind: 'verified', uploadId: session.progress.uploadId, ...verified }, token);
      } catch (error) {
        if (error instanceof InvalidOriginalError) {
          await this.reject(session, token, error.message);
          return;
        }
        throw error;
      }
      session = (await this.transfers.get(id))!;
    }
    if (session.progress.kind === 'verified') {
      const result = await this.transfers.commit(id, token, this.config.getEnv().transfer.stageMaxAgeSeconds);
      if (!result) {
        session = (await this.transfers.get(id))!;
        if (session.cancelRequested) {
          await this.reject(session, token, 'Upload cancelled', 'aborted');
        }
        return;
      }
      if (!result.claimed) {
        const duplicate = await this.transfers.get(id);
        if (duplicate) {
          await this.cleanupRejected(duplicate, token);
        }
        return;
      }
      session = (await this.transfers.get(id))!;
    }
    if (session.progress.kind === 'committed' && !session.eventDelivered) {
      await this.events.emit('AssetCreate', {
        asset: { id: session.assetId, ownerId: session.ownerId },
        directUpload: true,
      });
      await this.transfers.db
        .updateTable('gallery_upload_session')
        .set({ eventDelivered: true })
        .where('id', '=', id)
        .execute();
    }
    await this.jobs.reconcileUploadJobs();
  }
}
