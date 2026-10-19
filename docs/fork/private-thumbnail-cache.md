# Private thumbnail and preview cache

The optional local cache serves repeated thumbnail and preview requests without another S3 download. The API still checks `AssetView` for every request, then selects the current derivative before it looks in the cache. Shared links keep their edited-image selection and filename privacy rules.

## Settings

| Environment variable                | Default                                   | Meaning                                                                                                   |
| ----------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GALLERY_THUMBNAIL_CACHE_ENABLED`   | `false`                                   | Enable the local derivative cache independently of direct uploads, original staging, and ranged metadata. |
| `GALLERY_THUMBNAIL_CACHE_DIRECTORY` | `<IMMICH_MEDIA_LOCATION>/thumbnail-cache` | Absolute path to a dedicated private directory owned by one API instance.                                 |
| `GALLERY_THUMBNAIL_CACHE_MAX_BYTES` | `1073741824`                              | Positive safe integer. Maximum derivative payload bytes retained or reserved for fills by this instance.  |

Keep the directory outside any web server's public document root. The API creates it with mode `0700` and creates byte files with mode `0600`. The cache contains private media. Local administrators and backups that can read its disk can read those bytes.

Give every replica a separate directory and budget. The standard server starts one API process per instance. A `.owner` marker prevents a second process that sees an occupied directory from importing, filling, or evicting its entries. The second process logs a warning and uses the existing storage backend. This cache does not provide a shared byte budget across containers or hosts.

## Serving and limits

The key contains the asset ID, selected file path, file type, selected edit state, requested size and edit choice, and `asset_file.updateId`. A new revision therefore misses the old entry even when the storage path stays the same. Old versions remain eligible for normal eviction. The cache never stores authorization decisions, signed URLs, originals, fullsize derivatives, or person and profile images.

A miss reserves the object's complete declared length before writing. The reservation and ready files share the byte budget. An atomic rename publishes the file only after its actual byte count matches the declared length. Matching concurrent requests share one fill. At most four different fills run at once. Additional misses use the existing backend. A fill has a 30 second stream timeout.

Ready files use least recently used eviction within the running instance. Response streams pin their entries until they close, including after a client aborts. If pinned files leave insufficient space, the request uses the normal backend. Oversized files, absent entries, invalid lengths, cache I/O failures, and ownership conflicts also use the normal backend. A failed fill may read S3 once before the fallback reads it again. Cache hits keep the endpoint's private cache headers, content type, content length, and content disposition.

The cap counts derivative payload bytes, including reservations. It does not measure filesystem allocation blocks, directory entries, or the owner marker. Use a dedicated directory. Do not add unrelated files or change cache files while the instance owns it. Startup recounts ready files, removes incomplete cache writes, and evicts entries if the configured cap shrank. Unrecognized filenames remain untouched.

With the flag disabled, the API uses its existing disk, S3 redirect, or S3 proxy path. The disabled path does not create the cache directory. No schema migration, API change, or client change is required for this cache.

## Restart and recovery

Normal process exit, `SIGTERM`, and `SIGINT` release the owner marker. The next process imports ready files. An application-managed shutdown also waits for outstanding fills before releasing ownership.

These hooks run in the API process. A supervisor or container shutdown that kills that process without delivering its signal can also leave the marker. Automatic recovery after a full container restart has not been established by the local owner-process signal tests.

`SIGKILL`, a machine crash, or failed marker removal can leave `.owner` behind. The next process logs `Thumbnail cache unavailable; using storage backend` and serves through its configured storage backend. It does not guess whether a PID belongs to a process in another container or steal the directory.

To restore caching after an ungraceful exit, stop the instance that owns this directory. Remove only its marker from the stopped instance's volume, then start the instance again. For the default container path, run this command while the instance is stopped and the volume is mounted at `/data`.

```sh
rm -f /data/thumbnail-cache/.owner
```

Replace that path if you configured another directory. Do not remove the marker while any process still owns the directory. Disabling the flag and restarting is the rollback path. Keep the retained bytes private or remove this dedicated cache directory after all its processes stop. Committed assets in S3 and the database do not depend on cache files.

## Verification

`server/src/services/derivative-cache.service.spec.ts` exercises real local files, concurrent misses, byte identity, revision changes, active pins, aborts, eviction, restart imports, ownership contention, and failure fallback. `server/test/transfer/verify-thumbnail-cache.mjs` checks the real authenticated Gallery HTTP endpoint, database revisions, and private S3 bytes against an observer's actual GET log. It requires explicitly configured disposable localhost services and a `noodle-` prefixed bucket.

Run the verifier's `setup` mode once against an empty disposable database. Run `enabled`, `tiny`, `disabled-proxy`, `disabled-redirect`, `failure`, and `stale-owner` against the corresponding server settings. Its required environment variables name the API URL, database URL, S3 endpoint and credentials, bucket, observer log, state file, and report file. The script refuses remote service hosts.

Set these variables before running `node test/transfer/verify-thumbnail-cache.mjs <mode>` from `server/`.

| Variable                                               | Value                                                                                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `CACHE_TEST_API_URL`                                   | Local API base URL ending in `/api`.                                                                                         |
| `CACHE_TEST_DATABASE_URL`                              | PostgreSQL connection URL for the disposable database.                                                                       |
| `CACHE_TEST_S3_ENDPOINT`                               | Local S3 observer endpoint.                                                                                                  |
| `CACHE_TEST_S3_ACCESS_KEY`, `CACHE_TEST_S3_SECRET_KEY` | Disposable local S3 credentials.                                                                                             |
| `CACHE_TEST_BUCKET`                                    | Dedicated private bucket whose name starts with `noodle-`.                                                                   |
| `CACHE_TEST_REQUEST_LOG`                               | Absolute path to the observer's JSONL request log. Each record needs `method` and the path `key`, including the bucket name. |
| `CACHE_TEST_STATE`                                     | Absolute path to the verifier's generated fixture state.                                                                     |
| `CACHE_TEST_REPORT`                                    | Absolute path for this run's JSON result. Not needed for `setup`.                                                            |

Local byte and GET-count checks do not establish the handoff's VPS p95 target. Repeat thumbnail latency below 100 ms p95 remains a deployment acceptance check on the actual VPS. This feature does not require a public CDN or public bucket.
