import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Test } from '@nestjs/testing';
import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3StorageBackend } from 'src/backends/s3-storage.backend.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { UploadSessionCreateDto } from 'src/dtos/upload-session.dto.js';
import { JobName } from 'src/enum.js';
import { TransferDatabase } from 'src/gallery/transfer.schema.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UploadTransferRepository } from 'src/repositories/upload-transfer.repository.js';
import { up } from 'src/schema/migrations-gallery/1798000000000-AddUploadTransfers.js';
import { OriginalStageService } from 'src/services/original-stage.service.js';
import { StorageService } from 'src/services/storage.service.js';
import { UploadSessionService } from 'src/services/upload-session.service.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { newConfigRepositoryMock } from 'test/repositories/config.repository.mock.js';
import { newJobRepositoryMock } from 'test/repositories/job.repository.mock.js';

const enabled = process.env.IMMICH_TEST_DOCKER === 'true';

describe.skipIf(!enabled)('upload sessions with PostgreSQL and MinIO', () => {
  const containers: StartedTestContainer[] = [];
  let db: Kysely<TransferDatabase>;
  let backend: S3StorageBackend;
  let repo: UploadTransferRepository;
  let directory: string;
  const config = newConfigRepositoryMock();
  const events = { emit: vi.fn<EventRepository['emit']>().mockResolvedValue(undefined) };
  const jobs = newJobRepositoryMock();
  const logger = LoggingRepository.create();
  let stages: OriginalStageService;
  let service: UploadSessionService;
  const ownerId = randomUUID();
  const auth: AuthDto = {
    user: {
      id: ownerId,
      isAdmin: false,
      name: 'test',
      email: 'test@example.com',
      quotaSizeInBytes: null,
      quotaUsageInBytes: 0,
    },
  };
  const contents = Buffer.alloc(17 * 1024 ** 2, 7);
  const intent: UploadSessionCreateDto = {
    filename: 'test.jpg',
    size: contents.length,
    checksum: createHash('sha1').update(contents).digest('hex'),
    fileCreatedAt: new Date('2026-01-01'),
    fileModifiedAt: new Date('2026-01-01'),
  };

  beforeAll(async () => {
    const postgres = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({ POSTGRES_PASSWORD: 'postgres' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
      .start();
    containers.push(postgres);
    const connection = {
      connectionType: 'url',
      url: `postgres://postgres:postgres@${postgres.getHost()}:${postgres.getMappedPort(5432)}/postgres`,
    } satisfies Parameters<typeof getKyselyConfig>[0];
    db = new Kysely<TransferDatabase>(getKyselyConfig(connection));
    await sql`
      CREATE TABLE "user"(id uuid PRIMARY KEY, "quotaSizeInBytes" double precision, "quotaUsageInBytes" double precision NOT NULL DEFAULT 0);
      CREATE TABLE asset(id uuid PRIMARY KEY, "ownerId" uuid, "libraryId" uuid, checksum bytea, "checksumAlgorithm" text,
        "originalPath" text, "fileCreatedAt" timestamptz, "fileModifiedAt" timestamptz, "localDateTime" timestamptz,
        type text, duration integer, visibility text, "originalFileName" text);
      CREATE UNIQUE INDEX asset_owner_checksum ON asset("ownerId", checksum) WHERE "libraryId" IS NULL;
      CREATE TABLE asset_duplicate_checksum("ownerId" uuid, checksum bytea, "assetId" uuid);
      CREATE TABLE asset_exif("assetId" uuid PRIMARY KEY, "fileSizeInByte" double precision);
      CREATE TABLE asset_favorite("userId" uuid, "assetId" uuid);
      CREATE TABLE asset_metadata("assetId" uuid, key text, value jsonb);
      CREATE TABLE workflow(id uuid PRIMARY KEY, "ownerId" uuid, trigger text, enabled boolean);
    `.execute(db);
    const migrationDb = new Kysely<unknown>(getKyselyConfig(connection));
    await up(migrationDb);
    await migrationDb.destroy();
    await sql`INSERT INTO "user"(id) VALUES (${ownerId}::uuid)`.execute(db);
    const minio = await new GenericContainer(
      'cgr.dev/chainguard/minio:latest@sha256:bd014394a80898e68c149f2311fdf8d5a2c2f3bb2c33b9327ae6d02b4b065ae1',
    )
      .withEnvironment({ MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: 'minioadmin' })
      .withExposedPorts(9000)
      .withCommand(['server', '/data'])
      .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
      .start();
    containers.push(minio);
    const endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
    const client = new S3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    });
    await client.send(new CreateBucketCommand({ Bucket: 'transfers' }));
    client.destroy();
    backend = new S3StorageBackend({
      bucket: 'transfers',
      endpoint,
      region: 'us-east-1',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
      serveMode: 'proxy',
      presignedUrlExpiry: 300,
    });
    vi.spyOn(StorageService, 'getWriteBackend').mockReturnValue(backend);
    vi.spyOn(StorageService, 'resolveBackendForKey').mockReturnValue(backend);
    directory = await mkdtemp(join(tmpdir(), 'gallery-transfer-test-'));
    const env = config.getEnv();
    config.getEnv.mockReturnValue({
      ...env,
      storage: { ...env.storage, backend: 's3' },
      transfer: {
        ...env.transfer,
        directUploadEnabled: true,
        stageEnabled: true,
        stageDirectory: directory,
        stageMaxBytes: 64 * 1024 ** 2,
      },
    });
    repo = new UploadTransferRepository(db);
    stages = new OriginalStageService(repo, config);
    service = await makeService();
  }, 120_000);

  beforeEach(async () => {
    await sql`TRUNCATE gallery_upload_session, gallery_upload_reservation, gallery_original_stage, gallery_upload_job, gallery_stage_pin, gallery_upload_workflow, asset_exif, asset_favorite, asset_metadata, asset CASCADE`.execute(
      db,
    );
    await db
      .updateTable('user')
      .set({ quotaUsageInBytes: 0, quotaSizeInBytes: null })
      .where('id', '=', ownerId)
      .execute();
    events.emit.mockClear();
    jobs.reconcileUploadJobs.mockClear();
  });

  afterAll(async () => {
    service?.onModuleDestroy();
    vi.restoreAllMocks();
    await db?.destroy();
    await Promise.all(containers.map((container) => container.stop()));
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  const makeService = async () => {
    const module = await Test.createTestingModule({
      providers: [
        UploadSessionService,
        { provide: UploadTransferRepository, useValue: repo },
        { provide: ConfigRepository, useValue: config },
        { provide: OriginalStageService, useValue: stages },
        { provide: EventRepository, useValue: events },
        { provide: JobRepository, useValue: jobs },
        { provide: LoggingRepository, useValue: logger },
      ],
    }).compile();
    return module.get(UploadSessionService);
  };

  const upload = async (input = intent, omitLast = false, data = contents) => {
    const session = await service.create(auth, input);
    const numbers = Array.from({ length: Math.ceil(data.length / session.partSize) }, (_, index) => index + 1);
    const { parts } = await service.signParts(auth, session.id, omitLast ? numbers.slice(0, -1) : numbers);
    for (const part of parts) {
      const response = await fetch(part.url, {
        method: 'PUT',
        body: data.subarray((part.partNumber - 1) * session.partSize, part.partNumber * session.partSize),
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    return session;
  };

  const complete = async (id: string) => {
    await repo.requestComplete(id);
    await service.reconcile();
    return service.status(auth, id);
  };

  it('lists uploaded parts after service replacement and commits once after verification', async () => {
    const session = await upload();
    const reads = vi.spyOn(backend, 'get');
    const replacement = await makeService();
    const resumed = await replacement.status(auth, session.id);
    expect(resumed.parts.map((part) => part.size)).toEqual([16 * 1024 ** 2, 1024 ** 2]);
    const result = await complete(session.id);
    expect(result.state).toBe('committed');
    expect(await service.complete(auth, session.id)).toMatchObject({ result: result.result });
    await service.reconcile();
    expect(await db.selectFrom('asset').selectAll().execute()).toHaveLength(1);
    const user = await db
      .selectFrom('user')
      .select('quotaUsageInBytes')
      .where('id', '=', ownerId)
      .executeTakeFirstOrThrow();
    expect(user.quotaUsageInBytes).toBe(contents.length);
    const stage = await db.selectFrom('gallery_original_stage').selectAll().executeTakeFirstOrThrow();
    const stagedBytes = await readFile(stage.path!);
    expect(stagedBytes.equals(contents)).toBe(true);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(events.emit.mock.calls.filter(([name]) => name === 'AssetCreate')).toHaveLength(1);
    reads.mockRestore();
  });

  it('rejects corrupt bytes without creating or charging an asset', async () => {
    const session = await upload({ ...intent, checksum: '0'.repeat(40) });
    const result = await complete(session.id);
    expect(result.state).toBe('rejected');
    expect(await db.selectFrom('asset').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('gallery_upload_reservation').selectAll().execute()).toEqual([]);
    const rejected = await repo.get(session.id);
    expect(await backend.headObject(rejected!.key)).toBeUndefined();
  });

  it('rejects an incomplete manifest before reading the original', async () => {
    const session = await upload(intent, true);
    const reads = vi.spyOn(backend, 'get');
    const result = await complete(session.id);
    expect(result.state).toBe('rejected');
    expect(reads).not.toHaveBeenCalled();
    expect(await db.selectFrom('asset').selectAll().execute()).toEqual([]);
    reads.mockRestore();
  });

  it('recovers an ambiguous S3 completion using the fixed private key', async () => {
    const session = await upload();
    const originalComplete = backend.completeMultipart.bind(backend);
    vi.spyOn(backend, 'completeMultipart').mockImplementationOnce(async (...args) => {
      await originalComplete(...args);
      throw new Error('connection dropped after complete');
    });
    const result = await complete(session.id);
    expect(result.state).toBe('committed');
    vi.mocked(backend.completeMultipart).mockRestore();
  });

  it('serializes concurrent direct and legacy quota reservations', async () => {
    await db.updateTable('user').set({ quotaSizeInBytes: contents.length }).where('id', '=', ownerId).execute();
    const outcomes = await Promise.allSettled([
      service.create(auth, intent),
      repo.reserveLegacy(ownerId, contents.length),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(await db.selectFrom('gallery_upload_reservation').selectAll().execute()).toHaveLength(1);
  });

  it('lets cancellation win before SQL commit and keeps committed assets after later abort', async () => {
    const session = await upload();
    const verify = stages.verify.bind(stages);
    vi.spyOn(stages, 'verify').mockImplementationOnce(async (...args) => {
      const result = await verify(...args);
      await repo.requestCancel(session.id);
      return result;
    });
    const result = await complete(session.id);
    expect(result.state).toBe('aborted');
    expect(await db.selectFrom('asset').selectAll().execute()).toEqual([]);
    vi.mocked(stages.verify).mockRestore();
    const next = await upload();
    const nextResult = await complete(next.id);
    expect(nextResult.state).toBe('committed');
    await service.abort(auth, next.id);
    await service.reconcile();
    const status = await service.status(auth, next.id);
    expect(status.state).toBe('committed');
    expect(await db.selectFrom('asset').selectAll().execute()).toHaveLength(1);
  });

  it('keeps durable metadata dispatch after an event failure following the SQL commit', async () => {
    const session = await upload();
    events.emit.mockRejectedValueOnce(new Error('crash after commit'));
    await complete(session.id);
    const committed = await repo.get(session.id);
    expect(committed?.progress.kind).toBe('committed');
    expect(await repo.pendingJobs()).toMatchObject([{ item: { name: JobName.AssetExtractMetadata } }]);
    await service.reconcile();
    const delivered = await repo.get(session.id);
    expect(delivered?.eventDelivered).toBe(true);
    expect(await db.selectFrom('asset').selectAll().execute()).toHaveLength(1);
  });
});
