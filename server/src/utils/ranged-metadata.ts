import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3MultipartStore } from 'src/interfaces/s3-multipart.interface.js';

type Atom = { type: string; offset: number; size: number; headerSize: number };
type StoredAtom = Atom & { data: Buffer };
type RangeStore = Pick<S3MultipartStore, 'headObject' | 'readRange'>;

export type RangedMetadata =
  | { kind: 'complete'; localPath: string; bytes: number; sampleCount: number; cleanup: () => Promise<void> }
  | { kind: 'needsFullRead'; bytes: number; reason: string };

class FullReadRequired extends Error {}

function atoms(data: Buffer): StoredAtom[] {
  const result: StoredAtom[] = [];
  let offset = 0;
  while (offset < data.length) {
    if (data.length - offset < 8) {
      throw new FullReadRequired('Truncated atom header');
    }
    const size32 = data.readUInt32BE(offset);
    const headerSize = size32 === 1 ? 16 : 8;
    if (data.length - offset < headerSize) {
      throw new FullReadRequired('Truncated extended atom header');
    }
    const size = size32 === 1 ? Number(data.readBigUInt64BE(offset + 8)) : size32;
    if (!Number.isSafeInteger(size) || size < headerSize || size > data.length - offset) {
      throw new FullReadRequired('Invalid nested atom size');
    }
    result.push({
      type: data.toString('latin1', offset + 4, offset + 8),
      offset,
      size,
      headerSize,
      data: data.subarray(offset + headerSize, offset + size),
    });
    offset += size;
  }
  return result;
}

function only(entries: StoredAtom[], type: string): Buffer {
  const matching = entries.filter((entry) => entry.type === type);
  if (matching.length !== 1) {
    throw new FullReadRequired(`Expected one ${type} atom`);
  }
  return matching[0].data;
}

function allowed(entries: StoredAtom[], types: string[]) {
  if (entries.some((entry) => !types.includes(entry.type))) {
    throw new FullReadRequired('Unsupported metadata atom');
  }
}

function rawVideoSampleCount(moov: Buffer, media: Atom): number {
  const movie = atoms(moov);
  allowed(movie, ['mvhd', 'trak', 'udta']);
  for (const userData of movie) {
    if (userData.type !== 'udta') {
      continue;
    }
    allowed(atoms(userData.data), [
      '©nam',
      '©ART',
      '©alb',
      '©cmt',
      '©day',
      '©too',
      '©xyz',
      '©mak',
      '©mod',
      '©swr',
      '©des',
      '©gen',
      'name',
      'auth',
      'cprt',
    ]);
  }
  only(movie, 'mvhd');
  const track = atoms(only(movie, 'trak'));
  allowed(track, ['tkhd', 'edts', 'mdia']);
  only(track, 'tkhd');
  const mdia = atoms(only(track, 'mdia'));
  allowed(mdia, ['mdhd', 'hdlr', 'minf']);
  only(mdia, 'mdhd');
  const handler = only(mdia, 'hdlr');
  if (handler.length < 12 || handler.toString('latin1', 8, 12) !== 'vide') {
    throw new FullReadRequired('Only a sole raw video track is supported');
  }
  const minf = atoms(only(mdia, 'minf'));
  allowed(minf, ['vmhd', 'hdlr', 'dinf', 'stbl']);
  only(minf, 'vmhd');
  const dataReferences = only(atoms(only(minf, 'dinf')), 'dref');
  if (dataReferences.length !== 20 || dataReferences.readUInt32BE(4) !== 1) {
    throw new FullReadRequired('Unsupported data references');
  }
  const reference = atoms(dataReferences.subarray(8));
  if (reference.length !== 1 || only(reference, 'url ').readUInt32BE(0) !== 1) {
    throw new FullReadRequired('External media references are unsupported');
  }
  const table = atoms(only(minf, 'stbl'));
  allowed(table, ['stsd', 'stts', 'stsc', 'stsz', 'stco', 'co64']);
  const description = only(table, 'stsd');
  if (description.length < 8 || description.readUInt32BE(4) !== 1) {
    throw new FullReadRequired('Multiple sample descriptions are unsupported');
  }
  const sample = only(atoms(description.subarray(8)), 'raw ');
  if (
    sample.length < 78 ||
    sample.readUInt16BE(6) !== 1 ||
    sample.readUInt16BE(74) !== 24 ||
    sample.readUInt16BE(24) === 0 ||
    sample.readUInt16BE(26) === 0
  ) {
    throw new FullReadRequired('Unsupported raw video sample description');
  }
  allowed(atoms(sample.subarray(78)), ['fiel', 'pasp', 'colr', 'gama', 'clap']);
  const sizes = only(table, 'stsz');
  if (sizes.length !== 12) {
    throw new FullReadRequired('Only constant raw frame sizes are supported');
  }
  const frameSize = sizes.readUInt32BE(4);
  const sampleCount = sizes.readUInt32BE(8);
  if (sampleCount === 0 || sampleCount > 1_000_000) {
    throw new FullReadRequired('Unsupported raw video frame count');
  }
  if (frameSize !== sample.readUInt16BE(24) * sample.readUInt16BE(26) * 3) {
    throw new FullReadRequired('Invalid raw video frame sizes');
  }
  const timing = only(table, 'stts');
  const timingCount = timing.readUInt32BE(4);
  if (timing.length !== 8 + timingCount * 8) {
    throw new FullReadRequired('Incomplete sample timing');
  }
  let timedSamples = 0;
  for (let index = 0; index < timingCount; index++) {
    const count = timing.readUInt32BE(8 + index * 8);
    const duration = timing.readUInt32BE(12 + index * 8);
    if (count === 0 || duration === 0) {
      throw new FullReadRequired('Invalid sample timing');
    }
    timedSamples += count;
  }
  if (timedSamples !== sampleCount) {
    throw new FullReadRequired('Incomplete sample timing');
  }
  const chunks = only(table, 'stsc');
  if (chunks.length !== 20 || chunks.readUInt32BE(4) !== 1 || chunks.readUInt32BE(8) !== 1) {
    throw new FullReadRequired('Unsupported sample to chunk mapping');
  }
  const samplesPerChunk = chunks.readUInt32BE(12);
  if (samplesPerChunk === 0 || chunks.readUInt32BE(16) !== 1) {
    throw new FullReadRequired('Invalid sample to chunk mapping');
  }
  const offsetAtoms = table.filter((entry) => entry.type === 'stco' || entry.type === 'co64');
  if (offsetAtoms.length !== 1) {
    throw new FullReadRequired('Expected one chunk offset table');
  }
  const offsets = offsetAtoms[0];
  const offsetSize = offsets.type === 'stco' ? 4 : 8;
  const chunkCount = offsets.data.readUInt32BE(4);
  if (offsets.data.length !== 8 + chunkCount * offsetSize || Math.ceil(sampleCount / samplesPerChunk) !== chunkCount) {
    throw new FullReadRequired('Incomplete chunk offsets');
  }
  let previousEnd = media.offset + media.headerSize;
  for (let index = 0; index < chunkCount; index++) {
    const position = 8 + index * offsetSize;
    const offset =
      offsetSize === 4 ? offsets.data.readUInt32BE(position) : Number(offsets.data.readBigUInt64BE(position));
    const count = Math.min(samplesPerChunk, sampleCount - index * samplesPerChunk);
    const end = offset + count * frameSize;
    if (!Number.isSafeInteger(offset) || offset < previousEnd || end > media.offset + media.size) {
      throw new FullReadRequired('Invalid media chunk range');
    }
    previousEnd = end;
  }
  return sampleCount;
}

export async function prepareRangedMetadata(store: RangeStore, key: string, maxBytes: number): Promise<RangedMetadata> {
  let bytes = 0;
  let directory: string | undefined;
  const read = async (start: number, length: number) => {
    if (length > maxBytes - bytes) {
      throw new FullReadRequired('Metadata byte budget exceeded');
    }
    const stream = await store.readRange(key, start, length);
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) {
        throw new FullReadRequired('Invalid range response');
      }
      bytes += chunk.length;
      received += chunk.length;
      if (received > length) {
        stream.destroy();
        throw new FullReadRequired('Oversized range response');
      }
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    if (data.length !== length) {
      throw new FullReadRequired('Incomplete range response');
    }
    return data;
  };
  try {
    const object = await store.headObject(key);
    if (!object || object.bytes < 8 || object.bytes > 10 * 1024 ** 4) {
      throw new FullReadRequired('Unsupported object size');
    }
    const retained: { offset: number; data: Buffer }[] = [];
    const media: Atom[] = [];
    const movies: Buffer[] = [];
    let offset = 0;
    let atomCount = 0;
    while (offset < object.bytes) {
      if (++atomCount > 128 || object.bytes - offset < 8) {
        throw new FullReadRequired('Unsupported top-level atoms');
      }
      const header = await read(offset, 8);
      const size32 = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      const extended = size32 === 1 ? await read(offset + 8, 8) : undefined;
      const headerSize = extended ? 16 : 8;
      const size = extended ? Number(extended.readBigUInt64BE(0)) : size32 || object.bytes - offset;
      if (!Number.isSafeInteger(size) || size < headerSize || size > object.bytes - offset) {
        throw new FullReadRequired('Invalid top-level atom size');
      }
      const atom = { type, offset, size, headerSize };
      const completeHeader = extended ? Buffer.concat([header, extended]) : header;
      if (type === 'mdat') {
        media.push(atom);
        retained.push({ offset, data: completeHeader });
      } else if (['ftyp', 'moov', 'wide', 'free'].includes(type)) {
        const body = size === headerSize ? Buffer.alloc(0) : await read(offset + headerSize, size - headerSize);
        retained.push({ offset, data: Buffer.concat([completeHeader, body]) });
        if (type === 'moov') {
          movies.push(body);
        }
      } else {
        throw new FullReadRequired('Unsupported top-level atom');
      }
      offset += size;
    }
    if (movies.length !== 1 || media.length !== 1) {
      throw new FullReadRequired('Expected one movie and one media atom');
    }
    const sampleCount = rawVideoSampleCount(movies[0], media[0]);
    directory = await mkdtemp(join(tmpdir(), 'immich-metadata-'));
    const localPath = join(directory, 'metadata.mov');
    const file = await open(localPath, 'wx', 0o600);
    try {
      await file.truncate(object.bytes);
      for (const entry of retained) {
        let written = 0;
        while (written < entry.data.length) {
          const { bytesWritten } = await file.write(
            entry.data,
            written,
            entry.data.length - written,
            entry.offset + written,
          );
          if (bytesWritten === 0) {
            throw new FullReadRequired('Incomplete metadata file write');
          }
          written += bytesWritten;
        }
      }
    } finally {
      await file.close();
    }
    const cleanupDirectory = directory;
    return {
      kind: 'complete',
      localPath,
      sampleCount,
      bytes,
      cleanup: () => rm(cleanupDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
    return {
      kind: 'needsFullRead',
      bytes,
      reason: error instanceof Error ? error.message : 'Metadata range read failed',
    };
  }
}
