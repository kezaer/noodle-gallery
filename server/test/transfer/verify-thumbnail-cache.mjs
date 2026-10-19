import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { S3Client, CreateBucketCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Client } = require('pg');
const sharp = require('sharp');
const required = (name) => {
  assert(process.env[name], `Set ${name}`);
  return process.env[name];
};
const localUrl = (value) => {
  const url = new URL(value);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use disposable localhost services');
  return value;
};
const mode = process.argv[2] ?? 'enabled';
const base = localUrl(required('CACHE_TEST_API_URL'));
const statePath = required('CACHE_TEST_STATE');
const requestLog = required('CACHE_TEST_REQUEST_LOG');
const bucket = required('CACHE_TEST_BUCKET');
assert(bucket.startsWith('noodle-'), 'Use a disposable noodle- prefixed bucket');
const database = new Client({ connectionString: localUrl(required('CACHE_TEST_DATABASE_URL')) });
const s3 = new S3Client({
  endpoint: localUrl(required('CACHE_TEST_S3_ENDPOINT')),
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: required('CACHE_TEST_S3_ACCESS_KEY'),
    secretAccessKey: required('CACHE_TEST_S3_SECRET_KEY'),
  },
});
const password = 'Disposable-thumbnail-cache-test-2026';
const owner = { email: 'cache-owner@example.invalid', password, name: 'Cache owner' };
const viewer = { email: 'cache-viewer@example.invalid', password, name: 'Cache viewer' };
const json = async (path, data, token) => {
  const response = await fetch(base + path, {
    method: data ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const body = await response.json();
  assert(response.ok, `${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
};
const snapshot = async () => (await readFile(requestLog, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const count = async (key) => {
  const requests = await snapshot();
  return requests.filter((line) => line.method === 'GET' && line.key === `/${bucket}/${key}`).length;
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const image = (color) =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
const put = (key, bytes) =>
  s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: 'image/jpeg' }));
const headers = [];
const fetchMedia = async (asset, token, size = 'thumbnail', suffix = '') => {
  const response = await fetch(`${base}/assets/${asset.id}/thumbnail?size=${size}${suffix}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    redirect: 'manual',
  });
  const body = Buffer.from(await response.arrayBuffer());
  headers.push({
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    disposition: response.headers.get('content-disposition'),
  });
  return { response, body };
};
const exact = async (asset, token, expected = asset.thumbnail, size = 'thumbnail', suffix = '') => {
  const result = await fetchMedia(asset, token, size, suffix);
  assert.equal(result.response.status, 200);
  assert.equal(hash(result.body), hash(Buffer.from(expected, 'base64')));
  assert.equal(result.response.headers.get('content-type'), 'image/jpeg');
  assert.equal(Number(result.response.headers.get('content-length')), Buffer.from(expected, 'base64').length);
  assert.match(result.response.headers.get('cache-control'), /^private,/);
  return result;
};

try {
  await database.connect();
  if (mode === 'setup') {
    await s3.send(new CreateBucketCommand({ Bucket: bucket })).catch((error) => {
      if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(error.name)) throw error;
    });
    await json('/auth/admin-sign-up', owner);
    const login = await json('/auth/login', owner);
    const other = await json('/admin/users', viewer, login.accessToken);
    const assets = [];
    for (const color of ['#d02010', '#10c040']) {
      const id = randomUUID();
      const thumbnail = await image(color);
      const preview = await image('#3030ee');
      const edited = await image('#eeaa10');
      const key = `thumbs/${id}/thumbnail.jpg`;
      const previewKey = `thumbs/${id}/preview.jpg`;
      const editedKey = `thumbs/${id}/edited.jpg`;
      await Promise.all([put(key, thumbnail), put(previewKey, preview), put(editedKey, edited)]);
      await database.query(
        `insert into asset (id,"ownerId",type,"originalPath","originalFileName","fileCreatedAt","fileModifiedAt","localDateTime",checksum,"checksumAlgorithm")
         values ($1,$2,'IMAGE',$3,'private-camera-name.jpg',now(),now(),now(),$4,'sha1')`,
        [id, login.userId, `upload/${id}.jpg`, createHash('sha1').update(id).digest()],
      );
      await database.query(
        `insert into asset_file ("assetId",type,path,"isEdited") values ($1,'thumbnail',$2,false),($1,'preview',$3,false),($1,'thumbnail',$4,true)`,
        [id, key, previewKey, editedKey],
      );
      assets.push({
        id,
        key,
        previewKey,
        editedKey,
        thumbnail: thumbnail.toString('base64'),
        preview: preview.toString('base64'),
        edited: edited.toString('base64'),
      });
    }
    await writeFile(statePath, JSON.stringify({ ownerId: login.userId, viewerId: other.id, assets }, null, 2) + '\n');
    console.log(
      JSON.stringify({
        mode,
        assets: assets.map(({ id }) => id),
        thumbnailBytes: Buffer.from(assets[0].thumbnail, 'base64').length,
      }),
    );
  } else {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const [a, b] = state.assets;
    const login = await json('/auth/login', owner);
    const other = await json('/auth/login', viewer);
    const token = login.accessToken;
    if (mode === 'enabled') {
      await database.query('update asset_file set path=path where "assetId"=$1', [a.id]);
    }
    const before = await count(a.key);
    if (mode === 'enabled') {
      await Promise.all(Array.from({ length: 20 }, () => exact(a, token)));
      assert.equal((await count(a.key)) - before, 1, 'Concurrent misses share one S3 GET');
      for (let i = 0; i < 3; i++) await exact(a, token);
      assert.equal((await count(a.key)) - before, 1, 'Warm reads make no S3 GET');
      const deniedBefore = await count(a.key);
      assert.equal((await fetchMedia(a)).response.status, 401);
      const denied = await fetchMedia(a, other.accessToken);
      assert([400, 403].includes(denied.response.status), 'Other user cannot read a warm thumbnail');
      await database.query('update asset set "ownerId"=$2 where id=$1', [a.id, state.viewerId]);
      try {
        const revoked = await fetchMedia(a, token);
        assert([400, 403].includes(revoked.response.status), 'Revoked owner cannot read a warm thumbnail');
      } finally {
        await database.query('update asset set "ownerId"=$2 where id=$1', [a.id, state.ownerId]);
      }
      assert.equal(await count(a.key), deniedBefore, 'Denied requests never read storage');
      await exact(a, token, a.preview, 'preview');
      await exact(a, token, a.edited, 'thumbnail', '&edited=true');
      const shared = await json(
        '/shared-links',
        { type: 'INDIVIDUAL', assetIds: [a.id], showMetadata: false, allowDownload: false },
        token,
      );
      const sharedResult = await exact(
        a,
        undefined,
        a.edited,
        'thumbnail',
        `&key=${encodeURIComponent(shared.key)}&edited=false`,
      );
      assert.match(sharedResult.response.headers.get('content-disposition'), new RegExp(a.id));
      assert(!sharedResult.response.headers.get('content-disposition').includes('private-camera-name'));
      const oldRevision = (
        await database.query('select "updateId" from asset_file where "assetId"=$1 and path=$2', [a.id, a.key])
      ).rows[0].updateId;
      const blue = await image('#80e0ff');
      const changed = blue.equals(Buffer.from(a.thumbnail, 'base64')) ? await image('#e080ff') : blue;
      assert.notEqual(hash(changed), hash(Buffer.from(a.thumbnail, 'base64')));
      await put(a.key, changed);
      await database.query('update asset_file set path=path where "assetId"=$1 and path=$2', [a.id, a.key]);
      const revision = (
        await database.query('select "updateId" from asset_file where "assetId"=$1 and path=$2', [a.id, a.key])
      ).rows[0].updateId;
      assert.notEqual(revision, oldRevision);
      a.thumbnail = changed.toString('base64');
      await exact(a, token);
      assert.equal((await count(a.key)) - before, 2, 'A changed revision reads new bytes');
      await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
    } else if (mode === 'tiny') {
      await exact(a, token);
      await exact(b, token);
      await exact(a, token);
      assert.equal((await count(a.key)) - before, 2, 'Eviction refetches the first thumbnail');
    } else if (['disabled-proxy', 'failure', 'stale-owner'].includes(mode)) {
      await exact(a, token);
      await exact(a, token);
      assert.equal((await count(a.key)) - before, 2, 'Both requests use the normal S3 proxy');
    } else if (mode === 'disabled-redirect') {
      for (let i = 0; i < 2; i++) {
        const { response } = await fetchMedia(a, token);
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('cache-control'), 'private, no-cache, no-transform');
        const signed = await fetch(response.headers.get('location'));
        assert.equal(signed.status, 200);
        assert.equal(hash(Buffer.from(await signed.arrayBuffer())), hash(Buffer.from(a.thumbnail, 'base64')));
      }
      assert.equal((await count(a.key)) - before, 2);
    } else if (mode === 'warm') {
      await exact(a, token);
    } else {
      throw new Error(`Unknown mode ${mode}`);
    }
    const report = {
      mode,
      passed: true,
      assetId: a.id,
      originalGets: await count(`upload/${a.id}.jpg`),
      thumbnailGetDelta: (await count(a.key)) - before,
      headers,
    };
    await writeFile(required('CACHE_TEST_REPORT'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  }
} finally {
  s3.destroy();
  await database.end();
}
