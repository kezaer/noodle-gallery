import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const [path, output] = process.argv.slice(2);
assert(path && output, 'Pass a valid media fixture path and an output JSON path');
const base = process.env.GALLERY_TEST_API_URL;
assert(
  base && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname),
  'The verifier requires a local disposable API',
);
const credentials = {
  email: process.env.GALLERY_TEST_EMAIL ?? 'transfer-test@example.invalid',
  password: process.env.GALLERY_TEST_PASSWORD ?? 'Disposable-transfer-test-2026',
  name: 'Transfer test',
};
let apiBodyBytes = 0;
const request = async (route, { method = 'GET', data, token } = {}) => {
  const body = data === undefined ? undefined : JSON.stringify(data);
  apiBodyBytes += Buffer.byteLength(body ?? '');
  const response = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body,
  });
  const result = await response.json();
  assert(response.ok, `${route} returned ${response.status} ${JSON.stringify(result)}`);
  return result;
};
try {
  await request('/auth/admin-sign-up', { method: 'POST', data: credentials });
} catch {
  await request('/auth/login', { method: 'POST', data: credentials });
}
const { accessToken: token } = await request('/auth/login', { method: 'POST', data: credentials });
assert.equal((await request('/server/features', { token })).directUpload, true);
const size = (await stat(path)).size;
const hash = createHash('sha1');
for await (const chunk of createReadStream(path)) hash.update(chunk);
const checksum = hash.digest('hex');
const created = await request('/assets/upload-sessions', {
  method: 'POST',
  token,
  data: {
    filename: basename(path),
    size,
    checksum,
    fileCreatedAt: '2026-01-02T03:04:05.000Z',
    fileModifiedAt: '2026-01-02T03:04:05.000Z',
  },
});
const handle = await open(path, 'r');
const transfers = [];
const put = async (partNumber) => {
  const {
    parts: [signed],
  } = await request(`/assets/upload-sessions/${created.id}/parts`, {
    method: 'POST',
    token,
    data: { partNumbers: [partNumber] },
  });
  const start = (partNumber - 1) * created.partSize;
  const expected = Math.min(created.partSize, size - start);
  const bytes = Buffer.allocUnsafe(expected);
  const { bytesRead } = await handle.read(bytes, 0, expected, start);
  assert.equal(bytesRead, expected);
  const response = await fetch(signed.url, { method: 'PUT', body: bytes });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  transfers.push({ partNumber, bytes: bytesRead });
};
await put(1);
const resumed = await request(`/assets/upload-sessions/${created.id}`, { token });
assert.deepEqual(
  resumed.parts.map(({ partNumber }) => partNumber),
  [1],
);
const completed = new Set(resumed.parts.map(({ partNumber }) => partNumber));
for (let part = 1; part <= Math.ceil(size / created.partSize); part++) {
  if (!completed.has(part)) await put(part);
}
await handle.close();
await request(`/assets/upload-sessions/${created.id}/complete`, { method: 'POST', token });
const deadline = Date.now() + Number(process.env.GALLERY_TEST_TIMEOUT_MS ?? 300_000);
let status;
do {
  status = await request(`/assets/upload-sessions/${created.id}`, { token });
  if (['committed', 'duplicate', 'rejected', 'aborted', 'expired'].includes(status.state)) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
} while (Date.now() < deadline);
assert.equal(status.state, 'committed', JSON.stringify(status));
const repeated = await request(`/assets/upload-sessions/${created.id}/complete`, { method: 'POST', token });
assert.deepEqual(repeated.result, status.result);
assert.equal(transfers.filter(({ partNumber }) => partNumber === 1).length, 1);
assert.equal(
  transfers.reduce((sum, part) => sum + part.bytes, 0),
  size,
);
const result = {
  fixture: { file: basename(path), size, checksum },
  sessionId: created.id,
  result: status.result,
  resumedParts: resumed.parts,
  transfers,
  apiBodyBytes,
  mediaBytesSentToApi: 0,
};
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, transfers: transfers.length }));
