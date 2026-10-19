const atom = (type: string, body: Buffer) => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
};
const integers = (...values: number[]) => {
  const result = Buffer.alloc(values.length * 4);
  for (const [index, value] of values.entries()) {
    result.writeUInt32BE(value, index * 4);
  }
  return result;
};
export const rawMetadataMovie = (codec = 'raw ', externalReference = false) => {
  const sample = Buffer.alloc(78);
  sample.writeUInt16BE(1, 6);
  sample.writeUInt16BE(2, 24);
  sample.writeUInt16BE(2, 26);
  sample.writeUInt16BE(24, 74);
  const handler = Buffer.alloc(12);
  handler.write('vide', 8);
  const table = (offset: number) =>
    atom(
      'stbl',
      Buffer.concat([
        atom('stsd', Buffer.concat([integers(0, 1), atom(codec, sample)])),
        atom('stts', integers(0, 1, 2, 512)),
        atom('stsc', integers(0, 1, 1, 1, 1)),
        atom('stsz', integers(0, 12, 2)),
        atom('stco', integers(0, 2, offset, offset + 12)),
      ]),
    );
  const movie = (offset: number) =>
    atom(
      'moov',
      Buffer.concat([
        atom('mvhd', Buffer.alloc(0)),
        atom(
          'trak',
          Buffer.concat([
            atom('tkhd', Buffer.alloc(0)),
            atom(
              'mdia',
              Buffer.concat([
                atom('mdhd', Buffer.alloc(0)),
                atom('hdlr', handler),
                atom(
                  'minf',
                  Buffer.concat([
                    atom('vmhd', Buffer.alloc(0)),
                    atom(
                      'dinf',
                      atom('dref', Buffer.concat([integers(0, 1), atom('url ', integers(externalReference ? 0 : 1))])),
                    ),
                    table(offset),
                  ]),
                ),
              ]),
            ),
          ]),
        ),
      ]),
    );
  const header = movie(0);
  return Buffer.concat([movie(header.length + 8), atom('mdat', Buffer.alloc(24, 7))]);
};

export const indexedMetadataMovie = ({
  audio = false,
  metadataTrack = false,
  codec = 'avc1',
}: { audio?: boolean; metadataTrack?: boolean; codec?: 'avc1' | 'hvc1' } = {}) => {
  const configuration =
    codec === 'avc1'
      ? atom('avcC', Buffer.from([1, 66, 0, 30, 255, 225, 0, 1, 103, 1, 0, 1, 104]))
      : (() => {
          const header = Buffer.alloc(23);
          header[0] = 1;
          header[21] = 3;
          header[22] = 3;
          return atom(
            'hvcC',
            Buffer.concat([header, ...[32, 33, 34].map((type) => Buffer.from([type, 0, 1, 0, 2, type * 2, 1]))]),
          );
        })();
  const visual = Buffer.alloc(78);
  visual.writeUInt16BE(1, 6);
  visual.writeUInt16BE(2, 24);
  visual.writeUInt16BE(2, 26);
  visual.writeUInt16BE(24, 74);
  const sound = Buffer.alloc(28);
  sound.writeUInt16BE(1, 6);
  sound.writeUInt16BE(2, 16);
  sound.writeUInt16BE(16, 18);
  sound.writeUInt32BE(48_000 * 65_536, 24);
  const track = (kind: 'vide' | 'soun' | 'meta', start: number) => {
    const sizes = kind === 'vide' ? [4, 5, 6] : [3, 3];
    const handler = Buffer.alloc(12);
    handler.write(kind, 8);
    let position = start;
    const offsets = sizes.map((size) => {
      const current = position;
      position += size;
      return current;
    });
    const sample =
      kind === 'vide'
        ? atom(codec, Buffer.concat([visual, configuration]))
        : atom('mp4a', Buffer.concat([sound, atom('esds', Buffer.from([0, 0, 0, 0, 3, 3, 0, 1, 0]))]));
    return atom(
      'trak',
      Buffer.concat([
        atom('tkhd', Buffer.alloc(84)),
        atom(
          'mdia',
          Buffer.concat([
            atom('mdhd', Buffer.alloc(24)),
            atom('hdlr', handler),
            atom(
              'minf',
              Buffer.concat([
                atom(kind === 'vide' ? 'vmhd' : 'smhd', Buffer.alloc(12)),
                atom('dinf', atom('dref', Buffer.concat([integers(0, 1), atom('url ', integers(1))]))),
                atom(
                  'stbl',
                  Buffer.concat([
                    atom('stsd', Buffer.concat([integers(0, 1), sample])),
                    atom('stts', integers(0, 1, sizes.length, 512)),
                    atom('stsc', integers(0, 1, 1, 1, 1)),
                    atom('stsz', integers(0, 0, sizes.length, ...sizes)),
                    atom('stco', integers(0, sizes.length, ...offsets)),
                    ...(kind === 'vide' ? [atom('stss', integers(0, 1, 1))] : []),
                  ]),
                ),
              ]),
            ),
          ]),
        ),
      ]),
    );
  };
  const movie = (start: number) =>
    atom(
      'moov',
      Buffer.concat([
        atom('mvhd', Buffer.alloc(100)),
        track('vide', start),
        ...(audio ? [track('soun', start + 15)] : []),
        ...(metadataTrack ? [track('meta', start + 15 + (audio ? 6 : 0))] : []),
      ]),
    );
  const header = movie(0);
  return Buffer.concat([
    movie(header.length + 8),
    atom('mdat', Buffer.alloc(15 + (audio ? 6 : 0) + (metadataTrack ? 6 : 0), 7)),
  ]);
};
