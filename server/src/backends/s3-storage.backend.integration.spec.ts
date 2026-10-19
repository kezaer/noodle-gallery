import { CreateBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { buffer } from 'node:stream/consumers';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3StorageBackend } from 'src/backends/s3-storage.backend.js';
import { CacheControl } from 'src/enum.js';
import { RangeNotSatisfiableError } from 'src/interfaces/storage-backend.interface.js';
import { prepareRangedMetadata } from 'src/utils/ranged-metadata.js';
import { indexedMetadataMovie, rawMetadataMovie } from 'test/fixtures/ranged-metadata.js';

const canRunDocker = process.env.IMMICH_TEST_DOCKER === 'true';

async function countKeysForPrefix(client: S3Client, bucket: string, prefix: string): Promise<number> {
  let count = 0;
  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    count += page.Contents?.length ?? 0;
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return count;
}

describe.skipIf(!canRunDocker)('S3StorageBackend integration (MinIO)', () => {
  let container: StartedTestContainer;
  let backend: S3StorageBackend;
  const bucket = 'test-bucket';

  beforeAll(async () => {
    // MinIO withdrew its own images on 2026-09-24; same pinned Chainguard build as
    // e2e/docker-compose.storage-migration.yml
    container = await new GenericContainer(
      'cgr.dev/chainguard/minio:latest@sha256:bd014394a80898e68c149f2311fdf8d5a2c2f3bb2c33b9327ae6d02b4b065ae1',
    )
      .withExposedPorts(9000)
      .withEnvironment({ MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: 'minioadmin' })
      .withCommand(['server', '/data'])
      .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
      .start();

    const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;

    // Create bucket via direct S3 client
    const client = new S3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    client.destroy();

    backend = new S3StorageBackend({
      bucket,
      region: 'us-east-1',
      endpoint,
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
      presignedUrlExpiry: 3600,
      serveMode: 'redirect',
    });
  }, 60_000);

  afterAll(async () => {
    await container?.stop();
  });

  it('uses real bounded S3 ranges for an indexed raw MOV without downloading pixels', async () => {
    const data = rawMetadataMovie();
    const key = 'metadata/raw.mov';
    await backend.put(key, data, { contentType: 'video/quicktime' });
    const result = await prepareRangedMetadata(backend, key, 4096);
    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') {
      throw new Error(result.reason);
    }
    try {
      const stats = await stat(result.localPath);
      const retained = await readFile(result.localPath);
      expect(stats.size).toBe(data.length);
      expect(result.bytes).toBe(data.length - 24);
      expect(retained.subarray(0, -24)).toEqual(data.subarray(0, -24));
      expect(retained.subarray(-24)).toEqual(Buffer.alloc(24));
    } finally {
      await result.cleanup();
    }
  });

  it('returns a full-read decision for a real S3 MOV with unsupported compressed samples', async () => {
    await backend.put('metadata/compressed.mov', rawMetadataMovie('avc1'));
    await expect(prepareRangedMetadata(backend, 'metadata/compressed.mov', 4096)).resolves.toMatchObject({
      kind: 'needsFullRead',
    });
  });

  it.each(['avc1', 'hvc1'] as const)('retains bounded %s and AAC samples from real S3 ranges', async (codec) => {
    const data = indexedMetadataMovie({ codec, audio: true });
    const key = `metadata/${codec}-aac.mp4`;
    await backend.put(key, data);
    const result = await prepareRangedMetadata(backend, key, 4096);
    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error(result.reason);
    try {
      expect(result).toMatchObject({
        codec: codec === 'avc1' ? 'h264' : 'hevc',
        audio: 'aac',
        bytes: data.length - 21 + 7,
      });
      const retained = await readFile(result.localPath);
      expect(retained.subarray(-21, -17)).toEqual(Buffer.alloc(4, 7));
      expect(retained.subarray(-6, -3)).toEqual(Buffer.alloc(3, 7));
      expect(retained.subarray(-17, -6)).toEqual(Buffer.alloc(11));
    } finally {
      await result.cleanup();
    }
  });

  it('rejects metadata-track S3 objects before treating their partial payload as complete', async () => {
    await backend.put('metadata/timed.mp4', indexedMetadataMovie({ metadataTrack: true }));
    await expect(prepareRangedMetadata(backend, 'metadata/timed.mp4', 4096)).resolves.toMatchObject({
      kind: 'needsFullRead',
      reason: 'Metadata and data tracks require a full read',
    });
  });

  it('should round-trip a file through put and get', async () => {
    const content = Buffer.from('hello from S3 integration test');
    await backend.put('test/round-trip.txt', content, { contentType: 'text/plain' });

    const { stream, contentType } = await backend.get('test/round-trip.txt');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString()).toBe('hello from S3 integration test');
    expect(contentType).toBe('text/plain');
  });

  it('should report exists correctly', async () => {
    await backend.put('test/exists.txt', Buffer.from('data'));
    expect(await backend.exists('test/exists.txt')).toBe(true);
    expect(await backend.exists('test/nope.txt')).toBe(false);
  });

  it('resumes nonempty signed browser parts and completes at the fixed key', async () => {
    const key = 'multipart/resume.bin';
    const firstBody = Buffer.alloc(5 * 1024 * 1024, 'j');
    const finalBody = Buffer.from('last multipart bytes');
    const uploadId = await backend.startMultipart(key, 'application/octet-stream');
    const [first] = await backend.signMultipartParts(key, uploadId, [1], 300);
    const firstUrl = new URL(first.url);
    expect(firstUrl.searchParams.has('x-amz-checksum-crc32')).toBe(false);
    expect(firstUrl.searchParams.has('x-amz-sdk-checksum-algorithm')).toBe(false);
    const firstPut = await fetch(first.url, { method: 'PUT', body: firstBody });
    expect(firstPut.status).toBe(200);
    const firstEtag = firstPut.headers.get('etag');
    expect(typeof firstEtag).toBe('string');
    await firstPut.arrayBuffer();

    const resumed = new S3StorageBackend({
      bucket,
      region: 'us-east-1',
      endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
      presignedUrlExpiry: 3600,
      serveMode: 'redirect',
    });
    await expect(resumed.listMultipartParts(key, uploadId)).resolves.toEqual([
      { partNumber: 1, etag: firstEtag, size: 5_242_880 },
    ]);
    await expect(resumed.headObject(key)).resolves.toBeUndefined();

    const [last] = await resumed.signMultipartParts(key, uploadId, [2], 300);
    const lastPut = await fetch(last.url, { method: 'PUT', body: finalBody });
    expect(lastPut.status).toBe(200);
    const lastEtag = lastPut.headers.get('etag');
    await lastPut.arrayBuffer();
    const parts = await resumed.listMultipartParts(key, uploadId);
    expect(parts).toEqual([
      { partNumber: 1, etag: firstEtag, size: 5_242_880 },
      { partNumber: 2, etag: lastEtag, size: 20 },
    ]);

    await resumed.completeMultipart(key, uploadId, parts);
    await expect(backend.headObject(key)).resolves.toEqual({ bytes: 5_242_900 });
    await expect(backend.readAll(key)).resolves.toEqual(Buffer.concat([firstBody, finalBody]));
    await expect(buffer(await backend.readRange(key, firstBody.length - 3, 9))).resolves.toEqual(
      Buffer.from('jjjlast m'),
    );
    await expect(buffer(await backend.readRange(key, firstBody.length + 15, 100))).resolves.toEqual(
      Buffer.from('bytes'),
    );
    await expect(backend.readRange(key, 5_242_900, 1)).rejects.toBeInstanceOf(RangeNotSatisfiableError);
    await resumed.abortMultipart(key, uploadId);
    await expect(backend.headObject(key)).resolves.toEqual({ bytes: 5_242_900 });
  }, 60_000);

  it('lists more than one thousand real parts and aborts without publishing an object', async () => {
    const key = 'multipart/paginated.bin';
    const uploadId = await backend.startMultipart(key, 'application/octet-stream');
    const numbers = Array.from({ length: 1001 }, (_, index) => index + 1);
    try {
      for (let offset = 0; offset < numbers.length; offset += 25) {
        const signed = await backend.signMultipartParts(key, uploadId, numbers.slice(offset, offset + 25), 300);
        await Promise.all(
          signed.map(async ({ url }) => {
            const response = await fetch(url, { method: 'PUT', body: 'p' });
            expect(response.status).toBe(200);
            await response.arrayBuffer();
          }),
        );
      }
      const parts = await backend.listMultipartParts(key, uploadId);
      expect(parts.map(({ partNumber, size }) => ({ partNumber, size }))).toEqual(
        numbers.map((partNumber) => ({ partNumber, size: 1 })),
      );
      expect(parts.every(({ etag }) => etag.length > 0)).toBe(true);
      await expect(backend.headObject(key)).resolves.toBeUndefined();
    } finally {
      await backend.abortMultipart(key, uploadId);
    }
    await backend.abortMultipart(key, uploadId);
    await expect(backend.listMultipartParts(key, uploadId)).rejects.toMatchObject({ name: 'NoSuchUpload' });
    await expect(backend.headObject(key)).resolves.toBeUndefined();
  }, 120_000);

  it('should delete objects', async () => {
    await backend.put('test/delete-me.txt', Buffer.from('data'));
    expect(await backend.exists('test/delete-me.txt')).toBe(true);

    await backend.delete('test/delete-me.txt');
    expect(await backend.exists('test/delete-me.txt')).toBe(false);
  });

  it('should download to temp file and cleanup', async () => {
    await backend.put('test/temp-download.txt', Buffer.from('temp content'));
    const { tempPath, cleanup } = await backend.downloadToTemp('test/temp-download.txt');

    const content = await readFile(tempPath, 'utf8');
    expect(content).toBe('temp content');

    await cleanup();
    expect(existsSync(tempPath)).toBe(false);
  });

  it('should return presigned URL in redirect mode', async () => {
    await backend.put('test/presigned.txt', Buffer.from('presigned data'));
    const strategy = await backend.getServeStrategy('test/presigned.txt', {
      contentType: 'text/plain',
      cacheControl: CacheControl.PrivateWithCache,
    });
    expect(strategy.type).toBe('redirect');
    if (strategy.type !== 'redirect') {
      return;
    }

    expect(strategy.url).toContain('test/presigned.txt');
    expect(strategy.url).toContain('X-Amz');
  });

  it('deletePrefix sweeps objects across list-pagination and delete-batch boundaries', async () => {
    // 2500 keys exercises both SDK caps in one test: ListObjectsV2 returns 1000 per page,
    // DeleteObjects takes 1000 per call. Three pages in, three batches out.
    const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
    const verifyClient = new S3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    });

    const prefix = 'delete-prefix-boundary/';
    const totalKeys = 2500;
    const body = Buffer.from('x');
    const concurrency = 100;
    for (let offset = 0; offset < totalKeys; offset += concurrency) {
      const batch: Promise<unknown>[] = [];
      for (let i = 0; i < concurrency && offset + i < totalKeys; i++) {
        batch.push(backend.put(`${prefix}object-${offset + i}.txt`, body));
      }
      await Promise.all(batch);
    }

    const preCount = await countKeysForPrefix(verifyClient, bucket, prefix);
    expect(preCount).toBe(totalKeys);

    await backend.deletePrefix(prefix);

    const postCount = await countKeysForPrefix(verifyClient, bucket, prefix);
    expect(postCount).toBe(0);

    verifyClient.destroy();
  }, 120_000);

  it('should stream content in proxy mode', async () => {
    // Create a second backend instance in proxy mode
    const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
    const proxyBackend = new S3StorageBackend({
      bucket,
      region: 'us-east-1',
      endpoint,
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
      presignedUrlExpiry: 3600,
      serveMode: 'proxy',
    });

    await backend.put('test/proxy.txt', Buffer.from('proxy content'));
    const strategy = await proxyBackend.getServeStrategy('test/proxy.txt', {
      contentType: 'text/plain',
      cacheControl: CacheControl.PrivateWithCache,
    });
    expect(strategy.type).toBe('stream');
    // eslint-disable-next-line unicorn/prefer-early-return
    if (strategy.type === 'stream') {
      const chunks: Buffer[] = [];
      for await (const chunk of strategy.stream) {
        chunks.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString()).toBe('proxy content');
    }
  });

  it('should read a whole object into a buffer', async () => {
    await backend.put('test/read-all.txt', Buffer.from('whole object'));
    await expect(backend.readAll('test/read-all.txt')).resolves.toEqual(Buffer.from('whole object'));
  });

  it('should free a proxy read slot when the response it serves closes unread', async () => {
    const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
    const proxyBackend = new S3StorageBackend({
      bucket,
      region: 'us-east-1',
      endpoint,
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
      presignedUrlExpiry: 3600,
      serveMode: 'proxy',
      proxyReadConcurrency: 1,
    });
    const options = { contentType: 'text/plain', cacheControl: CacheControl.PrivateWithCache };
    await backend.put('test/abandoned.txt', Buffer.from('abandoned'));

    const response = new AbortController();
    const first = await proxyBackend.getServeStrategy('test/abandoned.txt', { ...options, signal: response.signal });
    response.abort();

    // with one slot, this read only starts once the abandoned one gave its slot back
    const second = await proxyBackend.getServeStrategy('test/abandoned.txt', options);
    expect(first.type === 'stream' && first.stream.destroyed).toBe(true);
    if (second.type !== 'stream') {
      throw new Error('expected a stream');
    }
    const chunks = await second.stream.toArray();
    expect(chunks.join('')).toBe('abandoned');
  });

  describe('range requests in proxy mode', () => {
    // 'proxy range content' is 19 bytes
    const body = 'proxy range content';
    let proxyBackend: S3StorageBackend;

    beforeAll(async () => {
      const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
      proxyBackend = new S3StorageBackend({
        bucket,
        region: 'us-east-1',
        endpoint,
        accessKeyId: 'minioadmin',
        secretAccessKey: 'minioadmin',
        presignedUrlExpiry: 3600,
        serveMode: 'proxy',
      });
      await backend.put('test/proxy-range.txt', Buffer.from(body));
    });

    const readRange = async (range: string) => {
      const strategy = await proxyBackend.getServeStrategy('test/proxy-range.txt', {
        contentType: 'text/plain',
        cacheControl: CacheControl.PrivateWithCache,
        range,
      });
      if (strategy.type !== 'stream') {
        throw new Error(`expected a stream strategy, got ${strategy.type}`);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of strategy.stream) {
        chunks.push(Buffer.from(chunk));
      }
      return { ...strategy, content: Buffer.concat(chunks).toString() };
    };

    // These prove the pass-through design: we never parse the Range header, and a real
    // S3 server resolves every syntax for us and reports the byte window it served.
    it('should serve a closed range', async () => {
      const { content, length, contentRange } = await readRange('bytes=0-4');
      expect(content).toBe('proxy');
      expect(length).toBe(5);
      expect(contentRange).toBe(`bytes 0-4/${body.length}`);
    });

    it('should serve an open-ended range', async () => {
      const { content, length, contentRange } = await readRange('bytes=12-');
      expect(content).toBe('content');
      expect(length).toBe(7);
      expect(contentRange).toBe(`bytes 12-18/${body.length}`);
    });

    it('should serve a suffix range', async () => {
      const { content, length, contentRange } = await readRange('bytes=-7');
      expect(content).toBe('content');
      expect(length).toBe(7);
      expect(contentRange).toBe(`bytes 12-18/${body.length}`);
    });

    it('should serve the whole object with no content range when no range is asked for', async () => {
      const strategy = await proxyBackend.getServeStrategy('test/proxy-range.txt', {
        contentType: 'text/plain',
        cacheControl: CacheControl.PrivateWithCache,
      });
      expect(strategy).toMatchObject({ type: 'stream', length: body.length });
      expect((strategy as { contentRange?: string }).contentRange).toBeUndefined();
      if (strategy.type === 'stream') {
        strategy.stream.destroy();
      }
    });

    it('should reject an unsatisfiable range', async () => {
      await expect(readRange('bytes=9999-10000')).rejects.toBeInstanceOf(RangeNotSatisfiableError);
    });
  });
});
