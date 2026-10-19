import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3MultipartStore } from 'src/interfaces/s3-multipart.interface.js';
import { indexedVideoMetadata } from 'src/utils/indexed-video-metadata.js';
import { FullReadRequired } from 'src/utils/metadata-atoms.js';

type Atom = { type: string; offset: number; size: number; headerSize: number };
type RangeStore = Pick<S3MultipartStore, 'headObject' | 'readRange'>;

export type RangedMetadata =
  | {
      kind: 'complete';
      localPath: string;
      bytes: number;
      sampleCount: number;
      codec: 'rawvideo' | 'h264' | 'hevc';
      audio: 'none' | 'aac';
      cleanup: () => Promise<void>;
    }
  | { kind: 'needsFullRead'; bytes: number; reason: string };

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
    const layout = indexedVideoMetadata(movies[0], {
      start: media[0].offset + media[0].headerSize,
      end: media[0].offset + media[0].size,
    });
    for (const sample of layout.samples) {
      retained.push({ offset: sample.start, data: await read(sample.start, sample.length) });
    }
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
      sampleCount: layout.sampleCount,
      codec: layout.codec,
      audio: layout.audio,
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
