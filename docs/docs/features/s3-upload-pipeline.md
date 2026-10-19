# Enable direct S3 uploads and retain originals for processing

Use this guide after you configure [S3 storage](/features/s3-storage). Both direct uploads and original retention are disabled by default. Keep the bucket private.

## Prepare the bucket

1. Make the configured S3 endpoint reachable from both the Gallery server and the browsers that upload files.
2. Grant the server access to put, read, and delete objects. Also grant `s3:AbortMultipartUpload` and `s3:ListMultipartUploadParts`. Keep these reusable credentials on the server.
3. Add `PUT` to the bucket's existing CORS methods for each Gallery origin. Exposing `ETag` is optional CORS compatibility for other clients. Gallery obtains authoritative part ETags through server-side S3 part listing. Preserve the existing `GET` and `HEAD` rules used for media delivery.

For an AWS-style CORS configuration, replace the example origin with your Gallery origin:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://gallery.example.com"],
      "AllowedMethods": ["GET", "HEAD", "PUT"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 300
    }
  ]
}
```

4. Configure a bucket lifecycle rule to abort incomplete multipart uploads after the longest allowed session lifetime. The default session lifetime is one day. A seven-day lifecycle interval covers that default.
5. Validate multipart signing, part listing, completion, abort, and object readback against your provider in a disposable bucket before enabling the new path. Provider-specific behavior requires its own verification.

CORS does not grant object access. The browser receives short-lived signed URLs for specific parts. Those URLs contain the provider's opaque multipart upload ID.

## Prepare the stage directory

1. Mount a persistent stage directory at the same path in every API and microservices process that handles uploads or processing jobs.
2. Give the server user read and write access to that directory.
3. Keep separate space available for ordinary scratch files and media processing outputs. The stage byte limit does not reserve filesystem capacity.
4. Set the stage directory and budget on every process:

```dotenv
GALLERY_ORIGINAL_STAGE_ENABLED=true
GALLERY_ORIGINAL_STAGE_DIRECTORY=/data/original-stage
GALLERY_ORIGINAL_STAGE_MAX_BYTES=10737418240
GALLERY_ORIGINAL_STAGE_MAX_AGE_SECONDS=86400
```

The example retains at most 10 GiB for up to one day. If you omit the directory, Gallery uses `original-stage` under `IMMICH_MEDIA_LOCATION`.

Legacy uploads retain their local file after the S3 write. Gallery uses a hard link on the same filesystem or an atomic local copy across filesystems. A direct upload reads the object once to verify its complete checksum and can retain those same bytes. The processing graph shares the retained copy, including person thumbnails created by later face-processing jobs.

When the budget is full, a stage expires, or local publication fails, processing uses ordinary scratch downloads. A lost stage can be fetched again. Keep S3 available throughout processing.

## Enable direct uploads

1. Set the flag on every server process:

```dotenv
GALLERY_S3_DIRECT_UPLOAD_ENABLED=true
```

2. Restart the server processes with the updated environment.
3. Confirm that authenticated `GET /api/server/features` reports `directUpload: true`.
4. Upload a new supported image or video through the web app. Wait for verification and processing to complete.
5. Interrupt a multipart upload, then select the same local file again. Confirm that the web app uploads only parts absent from the server's list.
6. Confirm that the asset opens and that metadata, thumbnails, and any configured video or face jobs complete.

Direct uploads require `IMMICH_STORAGE_BACKEND=s3`. Shared-link uploads, sidecars, live photos, and clients without session support continue through `POST /api/assets`. A completed multipart transfer remains invisible as an asset until the server verifies the actual object. Verification downloads the original into the server, so direct upload reduces browser-to-API traffic without eliminating server ingress from S3.

## Disable the new paths

1. Set both flags to `false`:

```dotenv
GALLERY_S3_DIRECT_UPLOAD_ENABLED=false
GALLERY_ORIGINAL_STAGE_ENABLED=false
```

2. Restart every server process with the updated environment.
3. Confirm that `GET /api/server/features` reports `directUpload: false` and that a normal upload succeeds.

The new binary continues reconciling existing sessions while S3 remains the write backend. Committed assets remain standard assets with their existing checksums, metadata, quota charges, and object keys. Disabling retention can cause pending jobs to download originals into scratch files.

## Prepare an older server image

Disabling flags is an operational rollback on the new binary. It does not remove migration records required for an older image to start.

1. Back up PostgreSQL before changing migration history.
2. Stop new uploads and let active sessions complete, expire, or abort with cleanup finished.
3. Wait for upload jobs and event dispatch to finish, quota reservations to clear, reader pins to expire, and retained stages to be reclaimed.
4. Stop all API and microservices processes.
5. From the Compose directory, run the following command with the new image still configured. It checks the exact recorded migration boundary and reverts both transfer migrations in one transaction.

```bash
docker compose run --rm --no-deps -T --entrypoint node immich-server --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import { ConfigRepository } from './dist/repositories/config.repository.js';
import { CompositeMigrationProvider } from './dist/schema/composite-migration-provider.js';
import { getKyselyConfig } from './dist/utils/database.js';

const db = new Kysely(getKyselyConfig(new ConfigRepository().getEnv().database.config));
try {
  const history = await db.selectFrom('kysely_migrations').select('name').orderBy('name', 'desc').execute();
  const target = '1797000000000-AddAssetLocalDateTimeIndex';
  assert.deepEqual(history.slice(0, 3).map(({ name }) => name), [
    '1798100000000-FenceOriginalStageGenerations',
    '1798000000000-AddUploadTransfers',
    target,
  ], 'Unexpected migration boundary. Stop and inspect the installed version.');
  const migrator = new Migrator({
    db,
    migrationTableName: 'kysely_migrations',
    migrationLockTableName: 'kysely_migrations_lock',
    allowUnorderedMigrations: true,
    provider: new CompositeMigrationProvider([
      resolve('dist/schema/migrations'),
      resolve('dist/schema/migrations-gallery'),
    ]),
  });
  const { error, results } = await migrator.migrateTo(target);
  assert.ifError(error);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await db.destroy();
}
JS
```

6. Confirm that both migrations report `Down` and `Success`. If the drain guard fails, both migrations remain recorded. Finish the drain on the new binary before retrying.
7. Start the older image only after both migration records are removed. Verify that committed assets open and that their quota usage is unchanged.

Do not revert unrelated migrations or delete history rows manually. The command deliberately refuses any different migration boundary.

The transfer rollback drops its six control tables. It preserves standard assets and their quota charges. A plain older-image restart against an unchanged database can fail because Kysely rejects migration names absent from that image.
