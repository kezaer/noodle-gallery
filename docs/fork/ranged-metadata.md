# Bounded S3 metadata reads

`GALLERY_RANGED_METADATA_ENABLED=true` enables a bounded metadata read before the existing full download. It defaults to `false` and does not enable direct uploads, retained originals, or the derivative cache.

A retained original stage remains the first choice. The bounded path applies only to S3 video assets without an available stage. It accepts a single RGB24 raw video track in a QuickTime MOV container with complete constant-size sample tables and self-contained media references. It retains every supported metadata atom and the media header in a private sparse temporary file. Pixel bytes remain holes. ExifTool and FFprobe use that local file and preserve the original offsets, duration, packet timestamps, and keyframe index.

Compressed video, audio or auxiliary tracks, unsupported atoms, external references, incomplete tables, tool errors, and missing required fields use the full download. An unsupported file can transfer the bounded probe bytes plus the full original. This first implementation does not promise bounded metadata reads for arbitrary MOV or MP4 files.

`GALLERY_RANGED_METADATA_MAX_BYTES` sets the aggregate S3 payload budget for one attempt. Its default is 4 MiB. Valid values are 1 KiB through 16 MiB. The reader scans at most 128 top-level atoms and rejects objects larger than 10 TiB. It accepts at most one million raw frames to bound the local packet index. The sparse file keeps the original logical size and consumes only the retained metadata blocks. The caller deletes it after extraction, including failures.

The existing filesystem modification-time behavior remains. Metadata extraction writes the temporary file's `mtime` to `asset_exif.modifyDate` and `asset.fileModifiedAt`. The bounded reader does not substitute an embedded modification date or a previous database timestamp.

When job telemetry is enabled, the reader records `immich.metadata.ranged.attempts`, `immich.metadata.ranged.bytes`, and `immich.metadata.ranged.fallbacks`. Debug logs include the asset ID, bytes, and fallback reason. The byte counter includes bounded S3 payloads. It excludes a subsequent full download, HTTP headers, and local sparse-file reads.

Authenticated original downloads and video playback retain their existing Range behavior. Proxy mode forwards Range to S3. Redirect mode returns the existing short-lived signed URL. The bounded metadata flag does not change authorization or playback routing.

## Verification

The focused server suite includes a real MinIO test of retained metadata bytes and unsupported-codec fallback. Run it with Docker available.

```sh
cd server
IMMICH_TEST_DOCKER=true pnpm exec vitest --config test/vitest.config.mjs run src/utils/ranged-metadata.spec.ts src/backends/s3-storage.backend.integration.spec.ts src/services/metadata.service.spec.ts src/repositories/config.repository.spec.ts
```

A local full-server trial used a valid 2,152,398,936-byte fast-start RGB24 MOV with 346 frames. Metadata re-extraction returned 2,136 S3 payload bytes across six Range responses. All 28 stable database EXIF fields matched the unchanged server baseline. The complete FFprobe result, all 346 packet and keyframe records, and 66 non-filesystem ExifTool tags matched a full local read. The fixture SHA-256 is `0e034a4ef186076391ce79f23b99db2363e42a31286e646aa57a528792d58017`. This result is specific to that supported fixture and field comparison.

The local playback trial used the baseline H.264 derivative. Proxy and signed-URL requests returned 206 with Content-Range. Suffix ranges worked, unsatisfiable ranges returned 416, and an unauthenticated proxy request returned 401. Decoding a frame after a five-second seek matched the local derivative through both paths.

No database migration is required for this flag. Set it to `false` and restart workers to restore the existing full-download metadata path.
