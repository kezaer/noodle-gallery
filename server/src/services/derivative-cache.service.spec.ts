import { once } from 'node:events';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { DiskStorageBackend } from 'src/backends/disk-storage.backend.js';
import { AssetFileType } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { DerivativeCacheKey, DerivativeCacheService } from 'src/services/derivative-cache.service.js';

const key = (path = 'a', updateId = '1'): DerivativeCacheKey => ({
  assetId: path,
  path,
  type: AssetFileType.Thumbnail,
  isEdited: false,
  updateId,
  size: AssetFileType.Thumbnail,
  edited: false,
});

describe('DerivativeCacheService', () => {
  let directory: string;
  let source: string;
  let config: ConfigRepository;
  let backend: DiskStorageBackend;
  let sut: DerivativeCacheService;
  let services: DerivativeCacheService[];

  const consume = async (result: Awaited<ReturnType<DerivativeCacheService['open']>>) => {
    if (!result) {
      return;
    }
    const bytes = await buffer(result.stream);
    if (!result.stream.closed) {
      await once(result.stream, 'close');
    }
    return bytes.toString();
  };
  const used = async () => {
    const allNames = await readdir(directory);
    const names = allNames.filter((name) => name !== '.owner');
    const files = await Promise.all(names.map((name) => stat(join(directory, name))));
    return files.reduce((sum, file) => sum + file.size, 0);
  };
  const create = () => {
    const service = new DerivativeCacheService(config, LoggingRepository.create());
    services.push(service);
    return service;
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'gallery-cache-test-'));
    source = await mkdtemp(join(tmpdir(), 'gallery-cache-source-'));
    services = [];
    config = new ConfigRepository();
    vi.spyOn(config, 'getEnv').mockReturnValue({
      ...config.getEnv(),
      thumbnailCache: { enabled: true, directory, maxBytes: 6 },
    });
    backend = new DiskStorageBackend(source, new StorageRepository(LoggingRepository.create()));
    await Promise.all(['a', 'b', 'c'].map((name) => writeFile(join(source, name), name.repeat(3))));
    sut = create();
  });

  afterEach(async () => {
    await Promise.all(services.map((service) => service.onModuleDestroy()));
    await Promise.all([directory, source].map((path) => rm(path, { recursive: true, force: true })));
  });

  it('coalesces concurrent misses and returns the exact bytes on warm reads', async () => {
    const get = vi.spyOn(backend, 'get');
    const results = await Promise.all(Array.from({ length: 20 }, () => sut.open(key(), backend).then(consume)));
    expect(results).toEqual(Array.from({ length: 20 }, () => 'aaa'));
    expect(await consume(await sut.open(key(), backend))).toBe('aaa');
    expect(get).toHaveBeenCalledTimes(1);
    expect(await used()).toBe(3);
    const directoryStats = await stat(directory);
    expect(directoryStats.mode & 0o777).toBe(0o700);
  });

  it('includes the selected derivative revision and edited choice in its key', async () => {
    const get = vi.spyOn(backend, 'get');
    expect(await consume(await sut.open(key(), backend))).toBe('aaa');
    await writeFile(join(source, 'a'), 'new');
    expect(await consume(await sut.open(key('a', '2'), backend))).toBe('new');
    expect(await consume(await sut.open({ ...key('a', '2'), edited: true }, backend))).toBe('new');
    expect(get).toHaveBeenCalledTimes(3);
    expect(await used()).toBe(6);
  });

  it('evicts the least recently used unpinned entry within the byte cap', async () => {
    const get = vi.spyOn(backend, 'get');
    expect(await consume(await sut.open(key('a'), backend))).toBe('aaa');
    expect(await consume(await sut.open(key('b'), backend))).toBe('bbb');
    expect(await consume(await sut.open(key('a'), backend))).toBe('aaa');
    expect(await consume(await sut.open(key('c'), backend))).toBe('ccc');
    expect(await consume(await sut.open(key('a'), backend))).toBe('aaa');
    expect(get).toHaveBeenCalledTimes(3);
    expect(await consume(await sut.open(key('b'), backend))).toBe('bbb');
    expect(get).toHaveBeenCalledTimes(4);
    expect(await used()).toBe(6);
  });

  it('keeps an active stream pinned and falls back when every eviction candidate is pinned', async () => {
    config.getEnv().thumbnailCache.maxBytes = 3;
    const held = await sut.open(key(), backend);
    expect(held?.length).toBe(3);
    expect(await sut.open(key('b'), backend)).toBeUndefined();
    expect(await used()).toBe(3);
    expect(await consume(held)).toBe('aaa');
    expect(await consume(await sut.open(key('b'), backend))).toBe('bbb');
    expect(await used()).toBe(3);
  });

  it('reserves bytes before concurrent partial writes and rejects a fill beyond the shared cap', async () => {
    const first = new PassThrough();
    const second = new PassThrough();
    const overflow = new PassThrough();
    vi.spyOn(backend, 'get')
      .mockResolvedValueOnce({ stream: first, length: 3 })
      .mockResolvedValueOnce({ stream: second, length: 3 })
      .mockResolvedValueOnce({ stream: overflow, length: 3 });
    const a = sut.open(key('a'), backend);
    let b: ReturnType<DerivativeCacheService['open']> | undefined;
    try {
      await vi.waitFor(async () => {
        const names = await readdir(directory);
        expect(names.filter((name) => name.endsWith('.partial'))).toHaveLength(1);
      });
      b = sut.open(key('b'), backend);
      await vi.waitFor(async () => {
        const names = await readdir(directory);
        expect(names.filter((name) => name.endsWith('.partial'))).toHaveLength(2);
      });
      first.write(Buffer.from('aa'));
      second.write(Buffer.from('bb'));
      await vi.waitFor(async () => expect(await used()).toBe(4));
      expect(await sut.open(key('c'), backend)).toBeUndefined();
      expect(overflow.destroyed).toBe(true);
      first.end(Buffer.from('a'));
      second.end(Buffer.from('b'));
      expect(await consume(await a)).toBe('aaa');
      expect(await consume(await b)).toBe('bbb');
      expect(await used()).toBe(6);
    } finally {
      first.destroy();
      second.destroy();
      overflow.destroy();
      await Promise.allSettled([a, b]);
    }
  });

  it('releases a stream pin after the consumer aborts', async () => {
    config.getEnv().thumbnailCache.maxBytes = 3;
    const held = await sut.open(key(), backend);
    if (!held) {
      throw new Error('Expected a cached stream');
    }
    held.stream.destroy();
    await once(held.stream, 'close');
    expect(await consume(await sut.open(key('b'), backend))).toBe('bbb');
  });

  it('refills an absent entry without returning stale or incomplete bytes', async () => {
    expect(await consume(await sut.open(key(), backend))).toBe('aaa');
    const names = await readdir(directory);
    const name = names.find((name) => name.endsWith('.cache'));
    if (!name) {
      throw new Error('Expected a cache file');
    }
    await rm(join(directory, name));
    await writeFile(join(source, 'a'), 'new');
    expect(await consume(await sut.open(key(), backend))).toBe('new');
  });

  it('imports existing ready files and cleans partial files after a graceful restart', async () => {
    expect(await consume(await sut.open(key(), backend))).toBe('aaa');
    await sut.onModuleDestroy();
    await writeFile(join(directory, `${'0'.repeat(64)}-a.partial`), 'partial');
    const replacement = create();
    const get = vi.spyOn(backend, 'get');
    expect(await consume(await replacement.open(key(), backend))).toBe('aaa');
    expect(get).not.toHaveBeenCalled();
    expect(await used()).toBe(3);
    const names = await readdir(directory);
    expect(names.some((name) => name.endsWith('.partial'))).toBe(false);
  });

  it('recounts and evicts existing files when the configured cap shrinks', async () => {
    expect(await consume(await sut.open(key(), backend))).toBe('aaa');
    expect(await consume(await sut.open(key('b'), backend))).toBe('bbb');
    await sut.onModuleDestroy();
    config.getEnv().thumbnailCache.maxBytes = 3;
    const replacement = create();
    expect(await consume(await replacement.open(key('b'), backend))).toBe('bbb');
    expect(await used()).toBe(3);
  });

  it('does not share ownership or delete another instance lock', async () => {
    expect(await consume(await sut.open(key(), backend))).toBe('aaa');
    const contender = create();
    expect(await contender.open(key(), backend)).toBeUndefined();
    await contender.onModuleDestroy();
    expect(await readdir(directory)).toContain('.owner');
    expect(await consume(await sut.open(key(), backend))).toBe('aaa');
  });

  it('leaves a stale owner marker untouched and falls back safely', async () => {
    await writeFile(join(directory, '.owner'), 'stale');
    expect(await sut.open(key(), backend)).toBeUndefined();
    expect(await readdir(directory)).toEqual(['.owner']);
  });

  it('does not initialize or read the backend when disabled', async () => {
    config.getEnv().thumbnailCache.enabled = false;
    const get = vi.spyOn(backend, 'get');
    expect(await sut.open(key(), backend)).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    { bytes: 'aa', length: 3 },
    { bytes: 'aaaa', length: 3 },
    { bytes: 'aaa', length: undefined },
    { bytes: 'aaa', length: 7 },
  ])('does not publish an invalid or oversized source %#', async ({ bytes, length }) => {
    vi.spyOn(backend, 'get').mockResolvedValue({ stream: Readable.from([Buffer.from(bytes)]), length });
    expect(await sut.open(key(), backend)).toBeUndefined();
    expect(await used()).toBe(0);
  });

  it('falls back on backend and local directory failures', async () => {
    const get = vi.spyOn(backend, 'get').mockRejectedValueOnce(new Error('provider unavailable'));
    expect(await sut.open(key(), backend)).toBeUndefined();
    get.mockRestore();
    await rm(directory, { recursive: true });
    await writeFile(directory, 'not a directory');
    expect(await sut.open(key(), backend)).toBeUndefined();
  });
});
