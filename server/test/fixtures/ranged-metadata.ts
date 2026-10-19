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
