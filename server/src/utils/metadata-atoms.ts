export type MetadataAtom = { type: string; data: Buffer };

export class FullReadRequired extends Error {}

export function metadataAtoms(data: Buffer): MetadataAtom[] {
  const result: MetadataAtom[] = [];
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
      data: data.subarray(offset + headerSize, offset + size),
    });
    offset += size;
  }
  return result;
}

export function onlyMetadataAtom(entries: MetadataAtom[], type: string): Buffer {
  const matching = entries.filter((entry) => entry.type === type);
  if (matching.length !== 1) {
    throw new FullReadRequired(`Expected one ${type} atom`);
  }
  return matching[0].data;
}

export function allowMetadataAtoms(entries: MetadataAtom[], types: string[]) {
  if (entries.some((entry) => !types.includes(entry.type))) {
    throw new FullReadRequired('Unsupported metadata atom');
  }
}
