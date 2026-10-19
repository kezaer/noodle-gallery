import {
  FullReadRequired,
  MetadataAtom,
  allowMetadataAtoms as allowed,
  metadataAtoms as atoms,
  onlyMetadataAtom as only,
} from 'src/utils/metadata-atoms.js';

type ByteRange = { start: number; length: number };
type TrackFormat = { kind: 'video'; codec: 'rawvideo' | 'h264' | 'hevc' } | { kind: 'audio'; codec: 'aac' };
type Track = TrackFormat & {
  sampleCount: number;
  samples: ByteRange[];
};

function embeddedMetadata(entries: MetadataAtom[]) {
  allowed(entries, [
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
    'meta',
  ]);
  for (const entry of entries) {
    if (entry.type !== 'meta') continue;
    if (entry.data.length < 4 || entry.data.readUInt32BE(0) !== 0) {
      throw new FullReadRequired('Unsupported metadata container');
    }
    const meta = atoms(entry.data.subarray(4));
    allowed(meta, ['hdlr', 'keys', 'ilst']);
    const handler = only(meta, 'hdlr');
    if (handler.length < 12 || !['mdir', 'mdta'].includes(handler.toString('latin1', 8, 12))) {
      throw new FullReadRequired('Unsupported metadata handler');
    }
    for (const item of atoms(only(meta, 'ilst'))) {
      allowed(atoms(item.data), ['data', 'mean', 'name']);
    }
  }
}

function codecConfiguration(type: string, data: Buffer) {
  if (type === 'avcC') {
    if (data.length < 7 || data[0] !== 1 || (data[4] & 3) !== 3 || (data[5] & 31) === 0) {
      throw new FullReadRequired('Incomplete AVC configuration');
    }
    let offset = 6;
    const readNals = (count: number) => {
      if (count === 0) throw new FullReadRequired('Incomplete AVC parameter sets');
      for (let index = 0; index < count; index++) {
        if (offset + 2 > data.length) throw new FullReadRequired('Incomplete AVC parameter sets');
        const length = data.readUInt16BE(offset);
        offset += 2;
        if (length === 0 || length > data.length - offset) throw new FullReadRequired('Incomplete AVC parameter sets');
        offset += length;
      }
    };
    readNals(data[5] & 31);
    if (offset >= data.length) throw new FullReadRequired('Incomplete AVC configuration');
    readNals(data[offset++]);
  } else {
    if (data.length < 23 || data[0] !== 1 || (data[21] & 3) !== 3) {
      throw new FullReadRequired('Incomplete HEVC configuration');
    }
    let offset = 23;
    const types = new Set<number>();
    for (let index = 0; index < data[22]; index++) {
      if (offset + 3 > data.length) throw new FullReadRequired('Incomplete HEVC parameter sets');
      const nalType = data[offset++] & 63;
      const count = data.readUInt16BE(offset);
      offset += 2;
      if (count === 0) throw new FullReadRequired('Incomplete HEVC parameter sets');
      for (let nal = 0; nal < count; nal++) {
        if (offset + 2 > data.length) throw new FullReadRequired('Incomplete HEVC parameter sets');
        const length = data.readUInt16BE(offset);
        offset += 2;
        if (length === 0 || length > data.length - offset) throw new FullReadRequired('Incomplete HEVC parameter sets');
        offset += length;
      }
      types.add(nalType);
    }
    if (offset !== data.length || [32, 33, 34].some((type) => !types.has(type))) {
      throw new FullReadRequired('Incomplete HEVC parameter sets');
    }
  }
}

function trackMetadata(data: Buffer, media: { start: number; end: number }): Track {
  const track = atoms(data);
  allowed(track, ['tkhd', 'edts', 'mdia', 'udta']);
  only(track, 'tkhd');
  for (const entry of track) if (entry.type === 'udta') embeddedMetadata(atoms(entry.data));
  const mdia = atoms(only(track, 'mdia'));
  allowed(mdia, ['mdhd', 'hdlr', 'minf']);
  only(mdia, 'mdhd');
  const handler = only(mdia, 'hdlr');
  const handlerType = handler.length >= 12 ? handler.toString('latin1', 8, 12) : '';
  if (!['vide', 'soun'].includes(handlerType))
    throw new FullReadRequired('Metadata and data tracks require a full read');
  const kind = handlerType === 'vide' ? 'video' : 'audio';
  const minf = atoms(only(mdia, 'minf'));
  allowed(minf, ['vmhd', 'smhd', 'hdlr', 'dinf', 'stbl']);
  only(minf, kind === 'video' ? 'vmhd' : 'smhd');
  const references = only(atoms(only(minf, 'dinf')), 'dref');
  if (references.length !== 20 || references.readUInt32BE(4) !== 1)
    throw new FullReadRequired('Unsupported data references');
  const reference = atoms(references.subarray(8));
  if (reference.length !== 1 || only(reference, 'url ').readUInt32BE(0) !== 1) {
    throw new FullReadRequired('External media references are unsupported');
  }
  const table = atoms(only(minf, 'stbl'));
  allowed(table, ['stsd', 'stts', 'ctts', 'stsc', 'stsz', 'stco', 'co64', 'stss', 'sdtp', 'sgpd', 'sbgp']);
  const description = only(table, 'stsd');
  if (description.length < 8 || description.readUInt32BE(4) !== 1) {
    throw new FullReadRequired('Multiple sample descriptions are unsupported');
  }
  const entries = atoms(description.subarray(8));
  if (entries.length !== 1) throw new FullReadRequired('Expected one sample entry');
  const entry = entries[0];
  const sample = entry.data;
  if (sample.length < 8 || sample.readUInt16BE(6) !== 1)
    throw new FullReadRequired('Unsupported sample data reference');
  let format: TrackFormat;
  let rawFrameSize: number | undefined;
  if (kind === 'video') {
    if (sample.length < 78 || !sample.readUInt16BE(24) || !sample.readUInt16BE(26)) {
      throw new FullReadRequired('Incomplete visual sample entry');
    }
    const extensions = atoms(sample.subarray(78));
    allowed(extensions, ['avcC', 'hvcC', 'btrt', 'fiel', 'pasp', 'colr', 'gama', 'clap', 'dvcC', 'dvvC']);
    switch (entry.type) {
      case 'raw ': {
        if (sample.readUInt16BE(74) !== 24 || extensions.some((item) => ['avcC', 'hvcC'].includes(item.type))) {
          throw new FullReadRequired('Unsupported raw video sample description');
        }
        format = { kind: 'video', codec: 'rawvideo' };
        rawFrameSize = sample.readUInt16BE(24) * sample.readUInt16BE(26) * 3;

        break;
      }
      case 'avc1': {
        format = { kind: 'video', codec: 'h264' };
        codecConfiguration('avcC', only(extensions, 'avcC'));

        break;
      }
      case 'hvc1': {
        format = { kind: 'video', codec: 'hevc' };
        codecConfiguration('hvcC', only(extensions, 'hvcC'));

        break;
      }
      default: {
        throw new FullReadRequired('Unsupported video codec');
      }
    }
  } else {
    if (entry.type !== 'mp4a' || sample.length < 28) throw new FullReadRequired('Unsupported audio codec');
    const version = sample.readUInt16BE(8);
    if (version !== 0 && version !== 1) throw new FullReadRequired('Unsupported audio sample entry');
    const extensions = atoms(sample.subarray(version === 0 ? 28 : 44));
    allowed(extensions, ['esds', 'wave', 'btrt', 'chan']);
    const configuration = extensions.some((item) => item.type === 'esds');
    if (!configuration) {
      const wave = atoms(only(extensions, 'wave'));
      allowed(wave, ['frma', 'mp4a', 'esds', '\0\0\0\0']);
      only(wave, 'esds');
    }
    format = { kind: 'audio', codec: 'aac' };
  }
  const sizes = only(table, 'stsz');
  if (sizes.length < 12) throw new FullReadRequired('Incomplete sample sizes');
  const commonSize = sizes.readUInt32BE(4);
  const sampleCount = sizes.readUInt32BE(8);
  if (sampleCount === 0 || sampleCount > 1_000_000) throw new FullReadRequired('Unsupported indexed sample count');
  if (sizes.length !== 12 + (commonSize ? 0 : sampleCount * 4)) throw new FullReadRequired('Incomplete sample sizes');
  if (rawFrameSize && commonSize !== rawFrameSize) throw new FullReadRequired('Invalid raw video frame sizes');
  const sizeAt = (index: number) => commonSize || sizes.readUInt32BE(12 + index * 4);
  for (const type of ['stts', 'ctts']) {
    const timingEntries = table.filter((entry) => entry.type === type);
    if (type === 'ctts' && timingEntries.length === 0) continue;
    const timing = only(table, type);
    if (timing.length < 8 || (timing[0] !== 0 && !(type === 'ctts' && timing[0] === 1))) {
      throw new FullReadRequired('Unsupported sample timing');
    }
    const count = timing.readUInt32BE(4);
    if (timing.length !== 8 + count * 8) throw new FullReadRequired('Incomplete sample timing');
    let total = 0;
    for (let index = 0; index < count; index++) {
      const samples = timing.readUInt32BE(8 + index * 8);
      if (!samples || (type === 'stts' && !timing.readUInt32BE(12 + index * 8))) {
        throw new FullReadRequired('Invalid sample timing');
      }
      total += samples;
    }
    if (total !== sampleCount) throw new FullReadRequired('Incomplete sample timing');
  }
  if (format.codec === 'h264' || format.codec === 'hevc') only(table, 'stss');
  for (const sync of table) {
    if (sync.type !== 'stss') continue;
    if (sync.data.length < 8 || sync.data.length !== 8 + sync.data.readUInt32BE(4) * 4) {
      throw new FullReadRequired('Incomplete sync sample table');
    }
    let previous = 0;
    for (let index = 8; index < sync.data.length; index += 4) {
      const sample = sync.data.readUInt32BE(index);
      if (sample <= previous || sample > sampleCount) throw new FullReadRequired('Invalid sync sample');
      previous = sample;
    }
  }
  const offsets = table.filter((entry) => entry.type === 'stco' || entry.type === 'co64');
  if (offsets.length !== 1) throw new FullReadRequired('Expected one chunk offset table');
  const offsetTable = offsets[0];
  const offsetSize = offsetTable.type === 'stco' ? 4 : 8;
  if (offsetTable.data.length < 8) throw new FullReadRequired('Incomplete chunk offsets');
  const chunkCount = offsetTable.data.readUInt32BE(4);
  if (offsetTable.data.length !== 8 + chunkCount * offsetSize) throw new FullReadRequired('Incomplete chunk offsets');
  const mapping = only(table, 'stsc');
  if (mapping.length < 8) throw new FullReadRequired('Incomplete sample to chunk mapping');
  const mappingCount = mapping.readUInt32BE(4);
  if (!mappingCount || mapping.length !== 8 + mappingCount * 12)
    throw new FullReadRequired('Incomplete sample to chunk mapping');
  const mappings: { first: number; count: number }[] = [];
  for (let index = 0; index < mappingCount; index++) {
    const offset = 8 + index * 12;
    const first = mapping.readUInt32BE(offset);
    const count = mapping.readUInt32BE(offset + 4);
    if (
      (index === 0 ? first !== 1 : first <= mappings[index - 1].first) ||
      first > chunkCount ||
      !count ||
      mapping.readUInt32BE(offset + 8) !== 1
    ) {
      throw new FullReadRequired('Invalid sample to chunk mapping');
    }
    mappings.push({ first, count });
  }
  const samples: ByteRange[] = [];
  let sampleIndex = 0;
  let mappingIndex = 0;
  let previousEnd = media.start;
  for (let chunk = 1; chunk <= chunkCount; chunk++) {
    if (mappingIndex + 1 < mappings.length && mappings[mappingIndex + 1].first === chunk) mappingIndex++;
    const offsetPosition = 8 + (chunk - 1) * offsetSize;
    const position =
      offsetSize === 4
        ? offsetTable.data.readUInt32BE(offsetPosition)
        : Number(offsetTable.data.readBigUInt64BE(offsetPosition));
    let end = position;
    if (!Number.isSafeInteger(position) || position < previousEnd || position < media.start)
      throw new FullReadRequired('Invalid media chunk range');
    for (let count = 0; count < mappings[mappingIndex].count; count++) {
      if (sampleIndex >= sampleCount) throw new FullReadRequired('Excess indexed samples');
      const length = sizeAt(sampleIndex++);
      if (!length || !Number.isSafeInteger(end + length) || end + length > media.end)
        throw new FullReadRequired('Invalid media chunk range');
      samples.push({ start: end, length });
      end += length;
    }
    previousEnd = end;
  }
  if (sampleIndex !== sampleCount) throw new FullReadRequired('Incomplete chunk sample coverage');
  return { ...format, sampleCount, samples };
}

export function indexedVideoMetadata(moov: Buffer, media: { start: number; end: number }) {
  const movie = atoms(moov);
  allowed(movie, ['mvhd', 'trak', 'udta', 'meta', 'iods']);
  only(movie, 'mvhd');
  for (const entry of movie) {
    if (entry.type === 'udta') embeddedMetadata(atoms(entry.data));
    else if (entry.type === 'meta') embeddedMetadata([entry]);
  }
  const tracks = movie.filter((entry) => entry.type === 'trak').map((entry) => trackMetadata(entry.data, media));
  const videos = tracks.filter((track) => track.kind === 'video');
  const audio = tracks.filter((track) => track.kind === 'audio');
  if (videos.length !== 1 || audio.length > 1) throw new FullReadRequired('Expected one video and optional AAC audio');
  const video = videos[0];
  if (video.codec === 'rawvideo' && audio.length > 0) throw new FullReadRequired('Unsupported video layout');
  const intervals = tracks.flatMap((track) => track.samples).sort((a, b) => a.start - b.start);
  for (let index = 1; index < intervals.length; index++) {
    if (intervals[index].start < intervals[index - 1].start + intervals[index - 1].length)
      throw new FullReadRequired('Overlapping media samples');
  }
  return {
    codec: video.codec,
    audio: audio.length > 0 ? ('aac' as const) : ('none' as const),
    sampleCount: video.sampleCount,
    samples: video.codec === 'rawvideo' ? [] : tracks.map((track) => track.samples[0]),
  };
}
