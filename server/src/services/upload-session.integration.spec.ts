import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { schemaDiff, schemaFromCode, schemaFromDatabase } from '@immich/sql-tools';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { Queue, Worker } from 'bullmq';
import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3StorageBackend } from 'src/backends/s3-storage.backend.js';
import { OnJob } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { UploadSessionCreateDto } from 'src/dtos/upload-session.dto.js';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
import { TransferDatabase } from 'src/gallery/transfer.schema.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UploadTransferRepository } from 'src/repositories/upload-transfer.repository.js';
import 'src/schema/index.js';
import { down, up } from 'src/schema/migrations-gallery/1798000000000-AddUploadTransfers.js';
import { up as fenceStages } from 'src/schema/migrations-gallery/1798100000000-FenceOriginalStageGenerations.js';
import { BaseService } from 'src/services/base.service.js';
import { JobService } from 'src/services/job.service.js';
import { OriginalStageService } from 'src/services/original-stage.service.js';
import { StorageService } from 'src/services/storage.service.js';
import { UploadSessionService } from 'src/services/upload-session.service.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { newConfigRepositoryMock } from 'test/repositories/config.repository.mock.js';
import { newJobRepositoryMock } from 'test/repositories/job.repository.mock.js';
import { newTestService } from 'test/utils.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link), rename: vi.fn(actual.rename) };
});

class OriginalReader extends BaseService {
  read(key: string) {
    return this.ensureLocalFile(key);
  }
}

const enabled = process.env.IMMICH_TEST_DOCKER === 'true';

describe.skipIf(!enabled)('upload sessions with PostgreSQL and MinIO', () => {
  const containers: StartedTestContainer[] = [];
  let db: Kysely<TransferDatabase>;
  let backend: S3StorageBackend;
  let repo: UploadTransferRepository;
  let directory: string;
  let databaseUrl: string;
  let redisConnection: { host: string; port: number };
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
    databaseUrl = connection.url;
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
    await fenceStages(migrationDb);
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
    const redis = await new GenericContainer(
      'valkey/valkey:9@sha256:c123e3715db63d06d4ad6964884037aa0d5d4d703939b9929954112889708e1d',
    )
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
    containers.push(redis);
    redisConnection = { host: redis.getHost(), port: redis.getMappedPort(6379) };

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
  it.each([
    { response: undefined, terminal: 'success', rejects: false, priorAttempts: 0 },
    { response: JobStatus.Failed, terminal: 'accepted', rejects: true, priorAttempts: 0 },
    { response: JobStatus.Failed, terminal: 'failed', rejects: true, priorAttempts: 2 },
  ])('records a tracked $response result as $terminal', async ({ response, terminal, rejects, priorAttempts }) => {
    const session = await upload();
    await complete(session.id);
    const [record] = await repo.pendingJobs();
    await db
      .updateTable('gallery_upload_job')
      .set({ attempts: priorAttempts })
      .where('token', '=', record.token)
      .execute();
    const { sut, mocks } = newTestService(JobService, { transfers: repo });
    mocks.job.run.mockResolvedValue(response);
    const job = { ...record.item, id: record.token };
    const promise = sut.onJobRun(QueueName.MetadataExtraction, job);
    if (rejects) {
      await expect(promise).rejects.toThrow('returned Failed');
    } else {
      await promise;
    }
    const state = await db
      .selectFrom('gallery_upload_job')
      .select('state')
      .where('token', '=', record.token)
      .executeTakeFirstOrThrow();
    expect(state.state).toBe(terminal);
  });

  it('propagates thrown errors and records the exhausted final attempt', async () => {
    const session = await upload();
    await complete(session.id);
    const [record] = await repo.pendingJobs();
    await db.updateTable('gallery_upload_job').set({ attempts: 2 }).where('token', '=', record.token).execute();
    const { sut, mocks } = newTestService(JobService, { transfers: repo });
    mocks.job.run.mockRejectedValue(new Error('processor failed'));
    const job = { ...record.item, id: record.token };
    await expect(sut.onJobRun(QueueName.MetadataExtraction, job)).rejects.toThrow('processor failed');
    const outcome = await db
      .selectFrom('gallery_upload_job')
      .selectAll()
      .where('token', '=', record.token)
      .executeTakeFirstOrThrow();
    expect(outcome.state).toBe('failed');
    expect(outcome.attempts).toBe(3);
  });

  it('keeps a pinned replacement when a verifier fails after losing its stage generation', async () => {
    const session = await upload();
    const row = await repo.get(session.id);
    if (!row || row.progress.kind !== 'uploading') throw new Error('Expected an open multipart session');
    await backend.completeMultipart(
      row.key,
      row.progress.uploadId,
      await backend.listMultipartParts(row.key, row.progress.uploadId),
    );
    const oldToken = await stages.reserve(row.assetId, row.key, contents.length);
    if (!oldToken) throw new Error('Expected stage reservation');
    const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
    const { promise: blocked, reject: failStream } = Promise.withResolvers<void>();
    const stream = Readable.from(
      (async function* () {
        markStarted?.();
        yield contents.subarray(0, 8);
        await blocked;
      })(),
    );
    const get = vi.spyOn(backend, 'get').mockResolvedValueOnce({ stream });
    const verifying = stages.verify(
      row.assetId,
      row.key,
      { bytes: contents.length, digest: intent.checksum },
      oldToken,
    );
    await started;
    await db
      .updateTable('gallery_original_stage')
      .set({ claimUntil: new Date(0) })
      .where('assetId', '=', row.assetId)
      .execute();
    const replacement = await stages.verify(row.assetId, row.key, { bytes: contents.length, digest: intent.checksum });
    const reader = await stages.acquire(row.key);
    expect(reader?.localPath).toBe(replacement.stagePath);
    const failure = expect(verifying).rejects.toThrow('stale verifier failed');
    failStream?.(new Error('stale verifier failed'));
    await failure;
    const current = await db
      .selectFrom('gallery_original_stage')
      .selectAll()
      .where('assetId', '=', row.assetId)
      .executeTakeFirstOrThrow();
    expect(current.path).toBe(replacement.stagePath);
    expect(current.retained).toBe(true);
    const bytes = await readFile(reader!.localPath);
    expect(bytes.equals(contents)).toBe(true);
    expect(
      await db.selectFrom('gallery_stage_pin').selectAll().where('assetId', '=', row.assetId).execute(),
    ).toHaveLength(1);
    await reader?.cleanup();
    get.mockRestore();
  });

  it('retains legacy local bytes through an atomic copy when hard links cross filesystems', async () => {
    const assetId = randomUUID();
    const key = `upload/${ownerId}/${assetId}.jpg`;
    const localPath = join(directory, `${assetId}-multer.jpg`);
    await writeFile(localPath, contents);
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error('Cross-device link'), { code: 'EXDEV' }));
    const reads = vi.spyOn(backend, 'get');
    try {
      expect(await stages.adoptLegacy(assetId, key, contents.length, localPath)).toBe(true);
      await rm(localPath);
      const reader = await stages.acquire(key);
      expect(reader).toBeDefined();
      const bytes = await readFile(reader!.localPath);
      expect(bytes.equals(contents)).toBe(true);
      const files = await readdir(directory);
      expect(files.filter((name) => name.startsWith(assetId))).toHaveLength(1);
      expect(reads).not.toHaveBeenCalled();
      await reader?.cleanup();
    } finally {
      reads.mockRestore();
    }
  });

  it('commits a verified original when the optional stage cannot be published', async () => {
    const session = await upload();
    const row = await repo.get(session.id);
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('No space left'), { code: 'ENOSPC' }));
    const reads = vi.spyOn(backend, 'get');
    try {
      const completed = await complete(session.id);
      expect(completed.state).toBe('committed');
      const stage = await db.selectFrom('gallery_original_stage').selectAll().executeTakeFirstOrThrow();
      expect(stage.path).toBeNull();
      expect(stage.retained).toBe(false);
      const files = await readdir(directory);
      expect(files.some((name) => name.startsWith(row!.assetId))).toBe(false);
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      reads.mockRestore();
    }
  });

  it('uses normal scratch downloads when the configured stage budget cannot fit the original', async () => {
    const env = config.getEnv();
    config.getEnv.mockReturnValue({ ...env, transfer: { ...env.transfer, stageMaxBytes: 1 } });
    const reads = vi.spyOn(backend, 'get');
    try {
      const session = await upload();
      const completed = await complete(session.id);
      expect(completed.state).toBe('committed');
      const row = await repo.get(session.id);
      const { sut: reader } = newTestService(OriginalReader, { originalStages: stages });
      for (let index = 0; index < 2; index++) {
        const local = await reader.read(row!.key);
        const bytes = await readFile(local.localPath);
        expect(bytes.equals(contents)).toBe(true);
        await local.cleanup();
        await expect(readFile(local.localPath)).rejects.toThrow();
      }
      expect(reads).toHaveBeenCalledTimes(3);
      const stage = await db.selectFrom('gallery_original_stage').selectAll().executeTakeFirstOrThrow();
      expect(stage.retained).toBe(false);
    } finally {
      reads.mockRestore();
      config.getEnv.mockReturnValue(env);
    }
  });

  it('refills a lost stage once for concurrent readers from separate service instances', async () => {
    const session = await upload();
    await complete(session.id);
    const stage = await db.selectFrom('gallery_original_stage').selectAll().executeTakeFirstOrThrow();
    await rm(stage.path!);
    const reads = vi.spyOn(backend, 'get');
    try {
      const replacement = new OriginalStageService(repo, config);
      const readers = await Promise.all([stages.acquire(stage.key), replacement.acquire(stage.key)]);
      expect(readers.every((reader) => reader !== undefined)).toBe(true);
      expect(readers[0]!.localPath).toBe(readers[1]!.localPath);
      const bytes = await readFile(readers[0]!.localPath);
      expect(bytes.equals(contents)).toBe(true);
      expect(reads).toHaveBeenCalledTimes(1);
      await Promise.all(readers.map((reader) => reader!.cleanup()));
    } finally {
      reads.mockRestore();
    }
  });

  it('keeps an expired stage until its active reader releases the pin', async () => {
    const session = await upload();
    await complete(session.id);
    const stage = await db.selectFrom('gallery_original_stage').selectAll().executeTakeFirstOrThrow();
    const reader = await stages.acquire(stage.key);
    expect(reader).toBeDefined();
    await db
      .updateTable('gallery_original_stage')
      .set({ expiresAt: new Date(0) })
      .where('assetId', '=', stage.assetId)
      .execute();
    await stages.reconcile();
    const bytes = await readFile(reader!.localPath);
    expect(bytes.equals(contents)).toBe(true);
    expect(await stages.acquire(stage.key)).toBeUndefined();
    await reader!.cleanup();
    await stages.reconcile();
    await expect(readFile(reader!.localPath)).rejects.toThrow();
  });

  it('records a real Redis deferred stalled failure even when BullMQ bypasses the application handler', async () => {
    const session = await upload();
    await complete(session.id);
    const [record] = await repo.pendingJobs();
    const prefix = `gallery-recovery-${randomUUID()}`;
    const queue = new Queue(QueueName.MetadataExtraction, { connection: redisConnection, prefix });
    let worker: Worker | undefined;
    try {
      await queue.add(record.item.name, record.item.data, {
        jobId: record.token,
        attempts: 3,
        removeOnComplete: false,
        removeOnFail: false,
      });
      const client = await queue.client;
      await client.hset(queue.toKey(record.token), { defa: 'job stalled more than allowable limit', ats: 2 });
      let calls = 0;
      worker = new Worker(
        QueueName.MetadataExtraction,
        () => {
          calls++;
          return Promise.resolve();
        },
        { connection: redisConnection, prefix },
      );
      await vi.waitFor(
        async () => {
          const actual = await queue.getJob(record.token);
          expect(await actual?.getState()).toBe('failed');
        },
        { timeout: 5000 },
      );
      expect(calls).toBe(0);
      class QueueHandlers {}
      for (const name of Object.values(JobName)) {
        const descriptor = { value: () => Promise.reject(new Error(`Unexpected processing of ${name}`)) };
        Object.defineProperty(QueueHandlers.prototype, name, descriptor);
        OnJob({ name, queue: QueueName.MetadataExtraction })(QueueHandlers.prototype, name, descriptor);
      }
      const module = await Test.createTestingModule({
        providers: [
          JobRepository,
          QueueHandlers,
          { provide: UploadTransferRepository, useValue: repo },
          { provide: ConfigRepository, useValue: config },
          { provide: EventRepository, useValue: events },
          { provide: LoggingRepository, useValue: logger },
          { provide: getQueueToken(QueueName.MetadataExtraction), useValue: queue },
        ],
      }).compile();
      const actualJobs = module.get(JobRepository);
      actualJobs.setup([QueueHandlers]);
      await actualJobs.reconcileUploadJobs();
      await actualJobs.reconcileUploadJobs();
      const exhausted = await db
        .selectFrom('gallery_upload_job')
        .selectAll()
        .where('token', '=', record.token)
        .executeTakeFirstOrThrow();
      expect(exhausted.state).toBe('failed');
      expect(exhausted.attempts).toBe(3);
      expect(await queue.getJobCountByTypes('failed')).toBe(1);
      await stages.reconcile();
      const stage = await db
        .selectFrom('gallery_original_stage')
        .select('retained')
        .where('assetId', '=', record.assetId)
        .executeTakeFirstOrThrow();
      expect(stage.retained).toBe(false);
    } finally {
      await worker?.close(true);
      await queue.close();
    }
  });

  it('keeps the control-table schema equal to its migration', async () => {
    const source = schemaFromCode({ overrides: true, namingStrategy: 'default' });
    const target = await schemaFromDatabase({ connection: { connectionType: 'url', url: databaseUrl } });
    for (const schema of [source, target]) {
      schema.tables = schema.tables.filter((table) => table.name.startsWith('gallery_'));
      schema.functions = [];
      schema.enums = [];
      schema.extensions = [];
      schema.parameters = [];
      schema.overrides = [];
    }
    expect(schemaDiff(source, target).items).toEqual([]);
  });

  it('refuses rollback while active and preserves committed assets after a drained rollback', async () => {
    const session = await upload();
    await expect(db.transaction().execute((tx) => down(tx))).rejects.toThrow('Drain uploads');
    const completed = await complete(session.id);
    expect(completed.state).toBe('committed');
    for (const record of await repo.pendingJobs()) {
      await repo.finishJob(record.token, 'success');
    }
    await stages.reconcile();
    await db.transaction().execute((tx) => down(tx));
    expect(await db.selectFrom('asset').selectAll().execute()).toHaveLength(1);
    const owner = await db
      .selectFrom('user')
      .select('quotaUsageInBytes')
      .where('id', '=', ownerId)
      .executeTakeFirstOrThrow();
    expect(owner.quotaUsageInBytes).toBe(contents.length);
  });
});
