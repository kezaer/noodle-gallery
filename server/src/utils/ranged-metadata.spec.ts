import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { prepareRangedMetadata } from 'src/utils/ranged-metadata.js';
import { indexedMetadataMovie, rawMetadataMovie } from 'test/fixtures/ranged-metadata.js';

const storeFor = (data: Buffer) => ({
  headObject: vi.fn().mockResolvedValue({ bytes: data.length }),
  readRange: vi.fn((key: string, start: number, length: number) =>
    Promise.resolve(Readable.from(data.subarray(start, start + length))),
  ),
});

describe(prepareRangedMetadata.name, () => {
  it('keeps all metadata and indexed offsets while leaving raw pixels sparse', async () => {
    const data = rawMetadataMovie();
    const store = storeFor(data);
    const result = await prepareRangedMetadata(store, 'private.mov', 4096);
    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') {
      throw new Error(result.reason);
    }
    try {
      expect(result.sampleCount).toBe(2);
      expect(result.bytes).toBe(data.length - 24);
      const stats = await stat(result.localPath);
      expect(stats.size).toBe(data.length);
      const sparse = await readFile(result.localPath);
      expect(sparse.subarray(0, -24)).toEqual(data.subarray(0, -24));
      expect(sparse.subarray(-24)).toEqual(Buffer.alloc(24));
    } finally {
      await result.cleanup();
    }
    await expect(stat(result.localPath)).rejects.toThrow();
  });

  it.each(['avc1', 'hvc1', 'jpeg'])('requests full data for unsupported %s packets', async (codec) => {
    const result = await prepareRangedMetadata(storeFor(rawMetadataMovie(codec)), 'private.mov', 4096);
    expect(result).toMatchObject({ kind: 'needsFullRead' });
  });

  it('rejects external media references', async () => {
    const result = await prepareRangedMetadata(storeFor(rawMetadataMovie('raw ', true)), 'private.mov', 4096);
    expect(result).toMatchObject({ kind: 'needsFullRead', reason: 'External media references are unsupported' });
  });

  it('never requests a range beyond its aggregate budget', async () => {
    const store = storeFor(rawMetadataMovie());
    const result = await prepareRangedMetadata(store, 'private.mov', 32);
    expect(result).toMatchObject({ kind: 'needsFullRead', bytes: 8, reason: 'Metadata byte budget exceeded' });
    expect(store.readRange).toHaveBeenCalledExactlyOnceWith('private.mov', 0, 8);
  });

  it('does not treat truncated range data as complete metadata', async () => {
    const store = storeFor(rawMetadataMovie());
    store.readRange.mockResolvedValueOnce(Readable.from(Buffer.alloc(2)));
    const result = await prepareRangedMetadata(store, 'private.mov', 4096);
    expect(result).toMatchObject({ kind: 'needsFullRead', bytes: 2, reason: 'Incomplete range response' });
  });

  it('rejects a sample whose payload lies outside mdat', async () => {
    const data = rawMetadataMovie();
    const location = data.indexOf('stco');
    data.writeUInt32BE(data.length, location + 12);
    const result = await prepareRangedMetadata(storeFor(data), 'private.mov', 4096);
    expect(result).toMatchObject({ kind: 'needsFullRead', reason: 'Invalid media chunk range' });
  });

  it('bounds the packet scan even when a small table declares millions of frames', async () => {
    const data = rawMetadataMovie();
    data.writeUInt32BE(1_000_001, data.indexOf('stsz') + 12);
    const result = await prepareRangedMetadata(storeFor(data), 'private.mov', 4096);
    expect(result).toMatchObject({ kind: 'needsFullRead', reason: 'Unsupported indexed sample count' });
  });

  it('falls back for malformed nested atoms without retaining a temp file', async () => {
    const data = rawMetadataMovie();
    data.writeUInt32BE(3, data.indexOf('stts') - 4);
    const result = await prepareRangedMetadata(storeFor(data), 'private.mov', 4096);
    expect(result).toMatchObject({ kind: 'needsFullRead', reason: 'Invalid nested atom size' });
  });
});

describe('indexed compressed metadata', () => {
  it.each(['avc1', 'hvc1'] as const)('retains the first %s sample and complete container index', async (codec) => {
    const data = indexedMetadataMovie({ codec });
    const result = await prepareRangedMetadata(storeFor(data), 'private.mp4', 4096);
    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error(result.reason);
    try {
      expect(result).toMatchObject({ codec: codec === 'avc1' ? 'h264' : 'hevc', audio: 'none', sampleCount: 3 });
      expect(result.bytes).toBe(data.length - 15 + 4);
      const retained = await readFile(result.localPath);
      expect(retained.subarray(0, -11)).toEqual(data.subarray(0, -11));
      expect(retained.subarray(-11)).toEqual(Buffer.alloc(11));
    } finally {
      await result.cleanup();
    }
  });

  it('retains both first samples for video with AAC audio', async () => {
    const data = indexedMetadataMovie({ audio: true });
    const result = await prepareRangedMetadata(storeFor(data), 'private.mp4', 4096);
    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error(result.reason);
    try {
      expect(result).toMatchObject({ codec: 'h264', audio: 'aac', bytes: data.length - 21 + 7 });
    } finally {
      await result.cleanup();
    }
  });

  it('charges selected samples against the same byte budget as container atoms', async () => {
    const data = indexedMetadataMovie({ audio: true });
    const result = await prepareRangedMetadata(storeFor(data), 'private.mp4', data.length - 21 + 6);
    expect(result).toMatchObject({
      kind: 'needsFullRead',
      reason: 'Metadata byte budget exceeded',
      bytes: data.length - 21 + 4,
    });
  });

  it('rejects timed metadata even when video and AAC tables are otherwise supported', async () => {
    const result = await prepareRangedMetadata(
      storeFor(indexedMetadataMovie({ audio: true, metadataTrack: true })),
      'private.mp4',
      4096,
    );
    expect(result).toMatchObject({ kind: 'needsFullRead', reason: 'Metadata and data tracks require a full read' });
  });

  it('rejects missing codec parameter sets', async () => {
    const data = indexedMetadataMovie();
    data[data.indexOf('avcC') + 9] = 0;
    const result = await prepareRangedMetadata(storeFor(data), 'private.mp4', 4096);
    expect(result).toMatchObject({ kind: 'needsFullRead', reason: 'Incomplete AVC configuration' });
  });

  it('rejects indexed samples outside media', async () => {
    const data = indexedMetadataMovie();
    data.writeUInt32BE(0xff_ff_ff_ff, data.indexOf('stco') + 12);
    const result = await prepareRangedMetadata(storeFor(data), 'private.mp4', 4096);
    expect(result).toMatchObject({ kind: 'needsFullRead', reason: 'Invalid media chunk range' });
  });
  it('rejects an incomplete variable sample-size table', async () => {
    const data = indexedMetadataMovie();
    data.writeUInt32BE(4, data.indexOf('stsz') + 12);
    expect(await prepareRangedMetadata(storeFor(data), 'private.mp4', 4096)).toMatchObject({
      kind: 'needsFullRead',
      reason: 'Incomplete sample sizes',
    });
  });

  it('rejects excess samples in the chunk mapping', async () => {
    const data = indexedMetadataMovie();
    data.writeUInt32BE(2, data.indexOf('stsc') + 16);
    expect(await prepareRangedMetadata(storeFor(data), 'private.mp4', 4096)).toMatchObject({ kind: 'needsFullRead' });
  });

  it('rejects sync samples outside the declared frame count', async () => {
    const data = indexedMetadataMovie();
    data.writeUInt32BE(4, data.indexOf('stss') + 12);
    expect(await prepareRangedMetadata(storeFor(data), 'private.mp4', 4096)).toMatchObject({
      kind: 'needsFullRead',
      reason: 'Invalid sync sample',
    });
  });

  it('rejects overlapping audio and video sample ranges', async () => {
    const data = indexedMetadataMovie({ audio: true });
    const video = data.indexOf('stco');
    const audio = data.indexOf('stco', video + 4);
    data.writeUInt32BE(data.readUInt32BE(video + 12), audio + 12);
    expect(await prepareRangedMetadata(storeFor(data), 'private.mp4', 4096)).toMatchObject({
      kind: 'needsFullRead',
      reason: 'Overlapping media samples',
    });
  });
});
