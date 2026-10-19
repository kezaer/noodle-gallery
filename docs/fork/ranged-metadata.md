# Bounded S3 metadata reads

`GALLERY_RANGED_METADATA_ENABLED=true` enables a bounded metadata read before the existing full download. It defaults to `false` and does not enable direct uploads, retained originals, or the derivative cache.

A retained original stage remains the first choice. The bounded path applies only to S3 video assets without an available stage. It accepts a single RGB24 raw video track, or one indexed `avc1` H.264 or `hvc1` HEVC video track with optional AAC audio. Every track must have one self-contained sample description and complete timing, size, chunk-offset, and sync-sample tables. Fragmented files, in-band configuration changes, auxiliary tracks, metadata tracks, external references, and unknown layouts use the existing full download.

The reader retains the complete supported container metadata and media header in a private sparse temporary file. For compressed video it also fetches the first real sample of each track. ExifTool keeps the existing `-ee` mode. The reader rejects tracks and pointer containers that would require payload metadata extraction in that mode. It does not substitute header-only extraction for the server's normal full-file metadata behavior.

Compressed stream probing requires complete raw probe fields and no warning or error output. Packet extraction uses FFprobe's container demuxer with stream analysis and codec parsing disabled. It requires an exact source-packet count and no errors. The complete index supplies packet timestamps, durations, and keyframe flags. Ordinary full-file probes retain their existing options. Missing configuration, unsupported atoms, tool errors, and incomplete required fields fall back to the full download.

`GALLERY_RANGED_METADATA_MAX_BYTES` sets one aggregate S3 payload budget for headers and selected samples. Its default is 4 MiB. Valid values are 1 KiB through 16 MiB. The reader scans at most 128 top-level atoms and rejects objects larger than 10 TiB or tracks with more than one million samples. An unsupported file can transfer the bounded probe bytes plus the full original. The sparse file keeps the original logical size and consumes only retained metadata and sample blocks. The caller deletes it after extraction, including failures.

The existing filesystem modification-time behavior remains. Metadata extraction writes the temporary file's `mtime` to `asset_exif.modifyDate` and `asset.fileModifiedAt`. The bounded reader does not substitute an embedded modification date or a previous database timestamp.

When job telemetry is enabled, the reader records `immich.metadata.ranged.attempts`, `immich.metadata.ranged.bytes`, and `immich.metadata.ranged.fallbacks`. Debug logs include the asset ID, bytes, and fallback reason. The byte counter includes bounded S3 payloads. It excludes a subsequent full download, HTTP headers, and local sparse-file reads.

Authenticated original downloads and video playback retain their existing Range behavior. Proxy mode forwards Range to S3. Redirect mode returns the existing short-lived signed URL. The bounded metadata flag does not change authorization or playback routing.

## Verification

The focused server suite includes a real MinIO test of retained metadata bytes and unsupported-codec fallback. Run it with Docker available.

```sh
cd server
IMMICH_TEST_DOCKER=true pnpm exec vitest --config test/vitest.config.mjs run src/utils/ranged-metadata.spec.ts src/backends/s3-storage.backend.integration.spec.ts src/services/metadata.service.spec.ts src/repositories/config.repository.spec.ts
```

A local full-server trial used a valid 2,156,355,343-byte H.264 MP4 with 79,926 real encoded frames. Re-extraction returned 401,022 S3 payload bytes across seven Range responses and no full GET. Stable asset, EXIF, video, audio, and keyframe database rows matched extraction from the complete local original. All stream probe fields, packet records, and non-filesystem ExifTool tags also matched. The fixture repeats the 346-frame baseline H.264 clip 231 times with stream copy. Every encoded packet matched its source cycle, media bytes contained no added padding, and decoded frames from three cycles matched. Its SHA-256 is `0d7e5335a9c8341bd34827b167ed8b644e1f5cd39423ccfa28482ca194359600`.

Additional trials matched full metadata for H.264 with AAC audio and a generated HEVC fixture with reordered frames. The audio case read 20,664 bytes. The HEVC case read 8,199 bytes. These generated fixtures prove codec and index behavior. They do not establish acceptance for all iPhone encoders, HDR variants, or embedded telemetry.

A valid MP4 containing timed text exercised the fallback. It read 4,506 bounded bytes and then one complete 749,660-byte original. Its database result matched the full path. A separate valid 2,152,398,936-byte RGB24 MOV still required only 2,136 bytes. Its 28 stable database EXIF fields, complete probe result, 346 packet records, and 66 non-filesystem ExifTool tags matched the original baseline. That fixture's SHA-256 is `0e034a4ef186076391ce79f23b99db2363e42a31286e646aa57a528792d58017`.

The local playback trial used the baseline H.264 derivative. Proxy and signed-URL requests returned 206 with Content-Range. Suffix ranges worked, unsatisfiable ranges returned 416, and an unauthenticated proxy request returned 401. Decoding a frame after a five-second seek matched the local derivative through both paths.

No database migration is required for this flag. Set it to `false` and restart workers to restore the existing full-download metadata path.
