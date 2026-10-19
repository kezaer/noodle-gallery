import { State, Status2, type UploadSessionResponseDto } from '@immich/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectUploads, putUploadPart, type RememberedUpload } from './direct-upload';

const checksum = 'a'.repeat(40);
const file = new File(['abcdefghijkl'], 'video.mov', { lastModified: 100 });
const record: RememberedUpload = {
  id: 'session',
  ownerId: 'owner',
  filename: file.name,
  size: 12,
  lastModified: 100,
  checksum,
};
const session = (partial: Partial<UploadSessionResponseDto> = {}): UploadSessionResponseDto => ({
  id: record.id,
  filename: record.filename,
  size: record.size,
  checksum,
  state: State.Uploading,
  partSize: 4,
  parts: [],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...partial,
});
const committed = () => session({ state: State.Committed, result: { id: 'asset', status: Status2.Created } });
const callbacks = () => ({ signal: new AbortController().signal, onProgress: vi.fn(), onState: vi.fn() });
const makeApi = () => ({
  create: vi.fn().mockResolvedValue(session()),
  get: vi.fn().mockResolvedValue(session()),
  sign: vi
    .fn()
    .mockImplementation(({ uploadSessionSignPartsDto }: { uploadSessionSignPartsDto: { partNumbers: number[] } }) =>
      Promise.resolve({
        parts: uploadSessionSignPartsDto.partNumbers.map((partNumber) => ({
          partNumber,
          url: `https://private.invalid/part-${partNumber}?signed=secret`,
          expiresAt: new Date().toISOString(),
        })),
      }),
    ),
  complete: vi.fn().mockResolvedValue(committed()),
  abort: vi.fn().mockResolvedValue(''),
});

describe('direct upload sessions', () => {
  beforeEach(() => localStorage.clear());

  it('resumes a persisted session after re-instantiation using only server-listed parts', async () => {
    const api = makeApi();
    const first = new DirectUploads(api);
    first.remember(record);
    api.get.mockResolvedValue(
      session({
        parts: [
          { partNumber: 1, size: 4, etag: 'provider' },
          { partNumber: 2, size: 1, etag: 'wrong-size' },
        ],
      }),
    );
    const put = vi.fn().mockResolvedValue(undefined);
    const client = new DirectUploads(api, put);
    const [restored] = client.list('owner');
    const progress = callbacks();

    await expect(client.transfer(restored, file, checksum, progress)).resolves.toEqual({
      id: 'asset',
      status: 'created',
    });

    expect(api.create).not.toHaveBeenCalled();
    expect(api.sign.mock.calls.map(([input]) => input.uploadSessionSignPartsDto.partNumbers)).toEqual([[2], [3]]);
    expect(put.mock.calls.map(([, body]) => body.size)).toEqual([4, 4]);
    expect(progress.onProgress.mock.calls).toEqual([
      [4, 12],
      [8, 12],
      [12, 12],
    ]);
    expect(api.complete).toHaveBeenCalledWith({ id: 'session' }, expect.anything());
    const persisted = localStorage.getItem('immich-direct-uploads-v1');
    expect(persisted).not.toMatch(/signed|secret|provider|etag|parts|token|url/i);
  });

  it('re-signs failed parts and bounds retries', async () => {
    const api = makeApi();
    api.get.mockResolvedValue(session({ partSize: 12 }));
    const put = vi.fn().mockRejectedValueOnce(new Error('expired signature')).mockResolvedValue(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);
    const client = new DirectUploads(api, put, wait);
    await client.transfer(record, file, checksum, callbacks());
    expect(api.sign).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
    put.mockRejectedValue(new Error('offline'));
    await expect(client.transfer(record, file, checksum, callbacks())).rejects.toThrow('offline');
    expect(put).toHaveBeenCalledTimes(5);
    expect(api.complete).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched bytes before requesting part signatures', async () => {
    const api = makeApi();
    const client = new DirectUploads(api);
    await expect(client.transfer(record, file, 'b'.repeat(40), callbacks())).rejects.toThrow(
      'upload_session_file_mismatch',
    );
    await expect(client.transfer(record, new File(['short'], 'video.mov'), checksum, callbacks())).rejects.toThrow(
      'upload_session_file_mismatch',
    );
    expect(api.get).not.toHaveBeenCalled();
    expect(api.sign).not.toHaveBeenCalled();
    expect(api.complete).not.toHaveBeenCalled();
  });

  it('does not trust the saved fingerprint when server intent differs', async () => {
    const api = makeApi();
    api.get.mockResolvedValue(session({ checksum: 'b'.repeat(40) }));
    await expect(new DirectUploads(api).transfer(record, file, checksum, callbacks())).rejects.toThrow(
      'upload_session_file_mismatch',
    );
    expect(api.sign).not.toHaveBeenCalled();
  });

  it('polls a verifying session across reload without any file bytes or PUTs', async () => {
    const api = makeApi();
    new DirectUploads(api).remember(record);
    api.get.mockResolvedValueOnce(session({ state: State.Verifying })).mockResolvedValueOnce(committed());
    const put = vi.fn();
    const client = new DirectUploads(api, put, vi.fn().mockResolvedValue(undefined));
    const [restored] = client.list('owner');
    await expect(client.poll(restored, callbacks())).resolves.toEqual({ id: 'asset', status: 'created' });
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.complete).not.toHaveBeenCalled();
    expect(api.sign).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('isolates owners, stops transfer on logout and keeps resumable identity', async () => {
    const api = makeApi();
    const client = new DirectUploads(api);
    client.remember(record);
    client.remember({ ...record, id: 'other-session', ownerId: 'someone-else' });
    const controller = client.start(record.id);
    const before = client.generation;
    client.stopAll();
    expect(controller.signal.aborted).toBe(true);
    expect(client.generation).toBe(before + 1);
    expect(client.list('owner')).toEqual([record]);
    expect(client.list('someone-else').map(({ id }) => id)).toEqual(['other-session']);
    await expect(
      client.transfer(record, file, checksum, { ...callbacks(), signal: controller.signal }),
    ).rejects.toThrow();
    expect(api.sign).not.toHaveBeenCalled();
    expect(api.complete).not.toHaveBeenCalled();
  });

  it('aborts an uncommitted session but returns a committed result if commit won', async () => {
    const api = makeApi();
    api.get.mockResolvedValue(committed());
    const client = new DirectUploads(api);
    client.remember(record);
    const controller = client.start(record.id);
    await expect(client.cancel(record)).resolves.toEqual(committed());
    expect(controller.signal.aborted).toBe(true);
    expect(api.abort).toHaveBeenCalledWith({ id: 'session' });
    expect(client.list('owner')).toEqual([]);
  });

  it('retains identity when cancellation fails', async () => {
    const api = makeApi();
    api.abort.mockRejectedValue(new Error('offline'));
    const client = new DirectUploads(api);
    client.remember(record);
    await expect(client.cancel(record)).rejects.toThrow('offline');
    expect(client.list('owner')).toEqual([record]);
  });

  it('never returns success or completes an aborted transfer', async () => {
    const api = makeApi();
    const controller = new AbortController();
    const put = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(controller.signal.reason);
    });
    await expect(
      new DirectUploads(api, put).transfer(record, file, checksum, { ...callbacks(), signal: controller.signal }),
    ).rejects.toThrow();
    expect(api.complete).not.toHaveBeenCalled();
  });

  it('does not publish terminal failed uploads', async () => {
    const api = makeApi();
    api.get.mockResolvedValue(session({ state: State.Rejected }));
    const client = new DirectUploads(api);
    client.remember(record);
    await expect(client.poll(record, callbacks())).rejects.toThrow('upload_session_failed');
    expect(client.list('owner')).toEqual([]);
  });

  it('ignores corrupt or unrecognized persisted data', () => {
    localStorage.setItem('immich-direct-uploads-v1', JSON.stringify([{ ...record, size: -1 }]));
    expect(new DirectUploads().list('owner')).toEqual([]);
    localStorage.setItem('immich-direct-uploads-v1', '{');
    expect(new DirectUploads().list('owner')).toEqual([]);
    localStorage.setItem('immich-direct-uploads-v1', JSON.stringify([{ ownerId: 'owner', signedUrl: 'secret' }]));
    expect(new DirectUploads().list('owner')).toEqual([]);
  });
});

describe('S3 part transport', () => {
  it('omits cookies and authorization and never uses the SDK upload wrapper', async () => {
    const response = new Response('', { status: 200 });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const body = new Blob(['part']);
    await putUploadPart('https://storage.invalid/part?signature=secret', body, new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledWith('https://storage.invalid/part?signature=secret', {
      method: 'PUT',
      body,
      signal: expect.any(AbortSignal),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
    });
    expect(response.bodyUsed).toBe(true);
    fetchMock.mockRestore();
  });

  it('does not start a PUT after cancellation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const controller = new AbortController();
    controller.abort();
    await expect(
      putUploadPart('https://storage.invalid/part', new Blob(['part']), controller.signal),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it('does not expose signed URLs in transport errors', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('https://storage.invalid/?secret=signature'));
    await expect(
      putUploadPart('https://storage.invalid/?secret=signature', new Blob(['part']), new AbortController().signal),
    ).rejects.toThrow('upload_session_interrupted');
    fetchMock.mockRestore();
  });
});
