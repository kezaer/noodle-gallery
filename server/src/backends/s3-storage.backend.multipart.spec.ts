import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  ListPartsCommand,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3StorageBackend } from 'src/backends/s3-storage.backend.js';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-s3')>()),
  S3Client: vi.fn(function () {
    return { send };
  }),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, createWriteStream: vi.fn(original.createWriteStream) };
});

describe('S3 multipart protocol', () => {
  let backend: S3StorageBackend;

  beforeEach(() => {
    backend = new S3StorageBackend({
      bucket: 'private-bucket',
      region: 'us-east-1',
      presignedUrlExpiry: 3600,
      serveMode: 'redirect',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    send.mockReset();
    vi.mocked(getSignedUrl).mockReset();
  });

  it('starts an upload with the permanent key and content type', async () => {
    send.mockResolvedValueOnce({ UploadId: 'provider-upload' });

    await expect(backend.startMultipart('upload/asset/original.jpg', 'image/jpeg')).resolves.toBe('provider-upload');
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(CreateMultipartUploadCommand);
    expect(command.input).toEqual({
      Bucket: 'private-bucket',
      Key: 'upload/asset/original.jpg',
      ContentType: 'image/jpeg',
    });
  });

  it.each([{}, { UploadId: '' }])('rejects an unusable upload ID from S3', async (response) => {
    send.mockResolvedValueOnce(response);

    await expect(backend.startMultipart('key', 'image/jpeg')).rejects.toThrow();
  });

  it('lists every page without interpreting ETags as checksums', async () => {
    send
      .mockResolvedValueOnce({
        Parts: [{ PartNumber: 1, ETag: 'opaque-provider-tag', Size: 5_242_880 }],
        IsTruncated: true,
        NextPartNumberMarker: '1',
      })
      .mockResolvedValueOnce({
        Parts: [{ PartNumber: 3, ETag: '"another-tag-2"', Size: 17 }],
        IsTruncated: false,
      });

    await expect(backend.listMultipartParts('key', 'provider-upload')).resolves.toEqual([
      { partNumber: 1, etag: 'opaque-provider-tag', size: 5_242_880 },
      { partNumber: 3, etag: '"another-tag-2"', size: 17 },
    ]);
    expect(send.mock.calls.map(([command]) => command.input)).toEqual([
      { Bucket: 'private-bucket', Key: 'key', UploadId: 'provider-upload', MaxParts: 1000 },
      { Bucket: 'private-bucket', Key: 'key', UploadId: 'provider-upload', MaxParts: 1000, PartNumberMarker: '1' },
    ]);
    expect(send.mock.calls.every(([command]) => command instanceof ListPartsCommand)).toBe(true);
  });

  it.each([
    { Parts: [{ PartNumber: 1, Size: 17 }], IsTruncated: false },
    { Parts: [{ PartNumber: 1, ETag: 'tag', Size: -1 }], IsTruncated: false },
    { Parts: [{ PartNumber: 10_001, ETag: 'tag', Size: 1 }], IsTruncated: false },
    { Parts: [{ PartNumber: 1, ETag: 'tag', Size: 1 }], IsTruncated: true },
    { Parts: [{ PartNumber: 1, ETag: 'tag', Size: 1 }], IsTruncated: true, NextPartNumberMarker: '0' },
    { Parts: [{ PartNumber: 1, ETag: 'tag', Size: 1 }], IsTruncated: true, NextPartNumberMarker: '2' },
    {
      Parts: [
        { PartNumber: 1, ETag: 'tag', Size: 1 },
        { PartNumber: 1, ETag: 'tag', Size: 1 },
      ],
      IsTruncated: false,
    },
  ])('rejects malformed part or pagination data', async (response) => {
    send.mockResolvedValueOnce(response);

    await expect(backend.listMultipartParts('key', 'provider-upload')).rejects.toThrow();
  });

  it('rejects a repeated part across pages', async () => {
    send
      .mockResolvedValueOnce({
        Parts: [{ PartNumber: 2, ETag: 'tag', Size: 1 }],
        IsTruncated: true,
        NextPartNumberMarker: '2',
      })
      .mockResolvedValueOnce({ Parts: [{ PartNumber: 2, ETag: 'tag', Size: 1 }], IsTruncated: false });

    await expect(backend.listMultipartParts('key', 'provider-upload')).rejects.toThrow('unordered multipart parts');
  });

  it('signs UploadPart with a shared explicit expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
    vi.mocked(getSignedUrl)
      .mockResolvedValueOnce('https://s3.test/part-3')
      .mockResolvedValueOnce('https://s3.test/part-1');

    await expect(backend.signMultipartParts('key', 'provider-upload', [3, 1], 300)).resolves.toEqual([
      { partNumber: 3, url: 'https://s3.test/part-3', expiresAt: '2026-10-19T12:05:00.000Z' },
      { partNumber: 1, url: 'https://s3.test/part-1', expiresAt: '2026-10-19T12:05:00.000Z' },
    ]);
    const command = vi.mocked(getSignedUrl).mock.calls[0][1];
    expect(command).toBeInstanceOf(UploadPartCommand);
    expect(command.input).toEqual({ Bucket: 'private-bucket', Key: 'key', UploadId: 'provider-upload', PartNumber: 3 });
    expect(vi.mocked(getSignedUrl).mock.calls[0][2]).toEqual({
      expiresIn: 300,
      signingDate: new Date('2026-10-19T12:00:00Z'),
    });
  });

  it.each([0, 10_001, 1.5])('rejects invalid part numbers before signing', async (partNumber) => {
    await expect(backend.signMultipartParts('key', 'provider-upload', [partNumber], 300)).rejects.toThrow();
  });

  it.each([0, 604_801, 1.5])('rejects expiry outside the signing protocol', async (expiresIn) => {
    await expect(backend.signMultipartParts('key', 'provider-upload', [1], expiresIn)).rejects.toThrow();
  });

  it('completes with exact provider tags and leaves ambiguous completion recovery to the caller', async () => {
    send.mockResolvedValueOnce({ ETag: 'opaque-completed-tag' });
    await backend.completeMultipart('key', 'provider-upload', [{ partNumber: 1, etag: 'opaque-part-tag', size: 17 }]);

    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(command.input).toEqual({
      Bucket: 'private-bucket',
      Key: 'key',
      UploadId: 'provider-upload',
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag: 'opaque-part-tag' }] },
    });

    send.mockRejectedValueOnce(new Error('connection lost after complete'));
    await expect(
      backend.completeMultipart('key', 'provider-upload', [{ partNumber: 1, etag: 'opaque-part-tag', size: 17 }]),
    ).rejects.toThrow('connection lost after complete');
    expect(send.mock.calls).toHaveLength(2);
  });

  it('rejects an incomplete completion response', async () => {
    send.mockResolvedValueOnce({});

    await expect(backend.completeMultipart('key', 'provider-upload', [])).rejects.toThrow();
  });

  it('aborts idempotently and preserves provider errors', async () => {
    send.mockResolvedValueOnce({});
    await backend.abortMultipart('key', 'provider-upload');
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(AbortMultipartUploadCommand);
    expect(command.input).toEqual({ Bucket: 'private-bucket', Key: 'key', UploadId: 'provider-upload' });

    send.mockRejectedValueOnce(new S3ServiceException({ name: 'NoSuchUpload', $fault: 'client', $metadata: {} }));
    await backend.abortMultipart('key', 'provider-upload');
    send.mockRejectedValueOnce(new Error('access denied'));
    await expect(backend.abortMultipart('key', 'provider-upload')).rejects.toThrow('access denied');
  });

  it('heads the fixed key and distinguishes absent objects from denied access', async () => {
    send.mockResolvedValueOnce({ ContentLength: 17 });
    await expect(backend.headObject('key')).resolves.toEqual({ bytes: 17 });

    send.mockRejectedValueOnce(new S3ServiceException({ name: 'NotFound', $fault: 'client', $metadata: {} }));
    await expect(backend.headObject('missing')).resolves.toBeUndefined();
    send.mockRejectedValueOnce(
      new S3ServiceException({ name: 'Forbidden', $fault: 'client', $metadata: { httpStatusCode: 403 } }),
    );
    await expect(backend.headObject('private')).rejects.toMatchObject({ name: 'Forbidden' });
  });

  it.each([{}, { ContentLength: -1 }, { ContentLength: Number.MAX_SAFE_INTEGER + 1 }])(
    'rejects invalid object lengths',
    async (response) => {
      send.mockResolvedValueOnce(response);
      await expect(backend.headObject('key')).rejects.toThrow();
    },
  );

  it('reads a bounded range and permits clipping at the end of an object', async () => {
    send.mockResolvedValueOnce({ Body: Readable.from(['tail']), ContentLength: 4, ContentRange: 'bytes 5-8/9' });

    const stream = await backend.readRange('key', 5, 20);
    await expect(buffer(stream)).resolves.toEqual(Buffer.from('tail'));
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
    expect(send.mock.calls[0][0].input.Range).toBe('bytes=5-24');
  });

  it.each([
    { ContentLength: 9 },
    { ContentLength: 9, ContentRange: 'bytes 0-8/9' },
    { ContentLength: 3, ContentRange: 'bytes 5-8/9' },
    { ContentLength: 4, ContentRange: 'bytes 5-8/8' },
  ])('destroys provider bodies that do not match the range', async (metadata) => {
    const body = Readable.from(['body']);
    send.mockResolvedValueOnce({ Body: body, ...metadata });

    await expect(backend.readRange('key', 5, 4)).rejects.toThrow('invalid range response');
    expect(body.destroyed).toBe(true);
  });

  it.each(['too long', 'x'])('rejects a body that differs from its declared range length', async (body) => {
    send.mockResolvedValueOnce({ Body: Readable.from([body]), ContentLength: 4, ContentRange: 'bytes 5-8/9' });
    const stream = await backend.readRange('key', 5, 4);

    await expect(buffer(stream)).rejects.toThrow('S3 range response');
  });

  it('closes the S3 body when a consumer destroys an unread range', async () => {
    const body = new Readable({ read() {} });
    send.mockResolvedValueOnce({ Body: body, ContentLength: 4, ContentRange: 'bytes 5-8/9' });
    const stream = await backend.readRange('key', 5, 4);

    stream.destroy();

    await vi.waitFor(() => expect(body.destroyed).toBe(true));
  });

  it.each([
    [-1, 1],
    [0, 0],
    [0.5, 1],
    [Number.MAX_SAFE_INTEGER, 2],
  ])('rejects invalid range bounds', async (start, length) => {
    await expect(backend.readRange('key', start, length)).rejects.toThrow();
  });

  it('removes a partially downloaded file after the source stream fails', async () => {
    const original = await vi.importActual<typeof import('node:fs')>('node:fs');
    let partialPath = '';
    vi.mocked(createWriteStream).mockImplementationOnce((path, options) => {
      partialPath = path.toString();
      return original.createWriteStream(path, options);
    });
    send.mockResolvedValueOnce({
      Body: Readable.from(
        (function* () {
          yield Buffer.from('partial bytes');
          throw new Error('source disconnected');
        })(),
      ),
    });

    await expect(backend.downloadToTemp('key')).rejects.toThrow('source disconnected');
    expect(partialPath).toContain('immich-');
    expect(existsSync(partialPath)).toBe(false);
  });
});
