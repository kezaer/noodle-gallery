import {
  abortUploadSession,
  completeUploadSession,
  createUploadSession,
  getUploadSession,
  signUploadSessionParts,
  State,
  type UploadSessionCreateDto,
  type UploadSessionResponseDto,
} from '@immich/sdk';
import { ExecutorQueue } from '$lib/utils/executor-queue';

export type RememberedUpload = Pick<UploadSessionCreateDto, 'filename' | 'size' | 'checksum'> & {
  id: string;
  ownerId: string;
  lastModified: number;
  albumId?: string;
};

type SessionApi = {
  create: typeof createUploadSession;
  get: typeof getUploadSession;
  sign: typeof signUploadSessionParts;
  complete: typeof completeUploadSession;
  abort: typeof abortUploadSession;
};
type UploadCallbacks = {
  signal: AbortSignal;
  onProgress: (loaded: number, total: number) => void;
  onState: (state: UploadSessionResponseDto['state']) => void;
};
export class DirectUploadError extends Error {
  constructor(
    public readonly key:
      | 'upload_session_interrupted'
      | 'upload_session_file_mismatch'
      | 'upload_session_failed'
      | 'upload_session_reselect',
  ) {
    super(key);
  }
}

const storageKey = 'immich-direct-uploads-v1';
const api: SessionApi = {
  create: createUploadSession,
  get: getUploadSession,
  sign: signUploadSessionParts,
  complete: completeUploadSession,
  abort: abortUploadSession,
};
const partQueue = new ExecutorQueue({ concurrency: 3 });

function parseRecord(value: unknown): RememberedUpload | undefined {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  const size = 'size' in value ? value.size : undefined;
  if (
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('ownerId' in value) ||
    typeof value.ownerId !== 'string' ||
    !('filename' in value) ||
    typeof value.filename !== 'string' ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !('checksum' in value) ||
    typeof value.checksum !== 'string' ||
    !/^[a-f\d]{40}$/i.test(value.checksum) ||
    !('lastModified' in value) ||
    typeof value.lastModified !== 'number'
  ) {
    return;
  }
  return {
    id: value.id,
    ownerId: value.ownerId,
    filename: value.filename,
    size,
    checksum: value.checksum,
    lastModified: value.lastModified,
    albumId: 'albumId' in value && typeof value.albumId === 'string' ? value.albumId : undefined,
  };
}

export function waitForUploadPoll(signal: AbortSignal, milliseconds = 1000): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

export async function putUploadPart(url: string, body: Blob, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 120_000);
  const abort = () => timeout.abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, {
      method: 'PUT',
      body,
      signal: timeout.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
    });
    if (!response.ok) {
      throw new DirectUploadError('upload_session_interrupted');
    }
    await response.arrayBuffer();
  } catch {
    signal.throwIfAborted();
    throw new DirectUploadError('upload_session_interrupted');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export class DirectUploads {
  #controllers = new Map<string, AbortController>();
  generation = 0;

  constructor(
    private readonly sessionApi = api,
    private readonly putPart = putUploadPart,
    private readonly wait = waitForUploadPoll,
    private readonly storage = () => localStorage,
  ) {}

  #records(): RememberedUpload[] {
    try {
      const value: unknown = JSON.parse(this.storage().getItem(storageKey) ?? '[]');
      return Array.isArray(value) ? value.flatMap((item: unknown) => parseRecord(item) ?? []) : [];
    } catch {
      return [];
    }
  }

  list(ownerId: string) {
    return this.#records().filter((record) => record.ownerId === ownerId);
  }

  #persistBestEffort(records: RememberedUpload[]) {
    try {
      this.storage().setItem(storageKey, JSON.stringify(records));
    } catch {
      return;
    }
  }

  remember(record: RememberedUpload) {
    this.#persistBestEffort([...this.#records().filter(({ id }) => id !== record.id), record]);
  }

  forget(record: RememberedUpload) {
    this.#persistBestEffort(
      this.#records().filter(({ id, ownerId }) => id !== record.id || ownerId !== record.ownerId),
    );
  }

  start(id: string) {
    this.#controllers.get(id)?.abort();
    const controller = new AbortController();
    this.#controllers.set(id, controller);
    return controller;
  }

  attach(id: string, controller: AbortController) {
    this.#controllers.set(id, controller);
  }

  release(controller: AbortController) {
    for (const [id, current] of this.#controllers) {
      if (current === controller) {
        this.#controllers.delete(id);
      }
    }
  }

  stopAll() {
    this.generation++;
    for (const controller of this.#controllers.values()) {
      controller.abort();
    }
    this.#controllers.clear();
  }

  stop(id: string) {
    this.#controllers.get(id)?.abort();
    this.#controllers.delete(id);
  }

  async create(
    ownerId: string,
    file: File,
    intent: UploadSessionCreateDto,
    albumId: string | undefined,
    signal: AbortSignal,
  ) {
    const session = await this.sessionApi.create({ uploadSessionCreateDto: intent }, { signal });
    const record = {
      id: session.id,
      ownerId,
      filename: file.name,
      size: file.size,
      lastModified: file.lastModified,
      checksum: intent.checksum,
      albumId,
    } satisfies RememberedUpload;
    this.remember(record);
    return record;
  }

  status(record: RememberedUpload, signal: AbortSignal) {
    return this.sessionApi.get({ id: record.id }, { signal });
  }

  async cancel(record: RememberedUpload) {
    this.stop(record.id);
    await this.sessionApi.abort({ id: record.id });
    const session = await this.status(record, new AbortController().signal);
    this.forget(record);
    return session;
  }

  async transfer(record: RememberedUpload, file: File, checksum: string, callbacks: UploadCallbacks) {
    if (file.size !== record.size || checksum !== record.checksum) {
      throw new DirectUploadError('upload_session_file_mismatch');
    }
    let session = await this.status(record, callbacks.signal);
    if (session.size !== file.size || session.checksum !== checksum) {
      throw new DirectUploadError('upload_session_file_mismatch');
    }
    if (session.state === State.Uploading) {
      callbacks.onState(session.state);
      const count = Math.ceil(file.size / session.partSize);
      const missing = Array.from({ length: count }, (_, index) => index + 1).filter((partNumber) => {
        const size = Math.min(session.partSize, file.size - (partNumber - 1) * session.partSize);
        return session.parts.every((part) => !(part.partNumber === partNumber && part.size === size));
      });
      let loaded =
        file.size -
        missing.reduce(
          (bytes, partNumber) => bytes + Math.min(session.partSize, file.size - (partNumber - 1) * session.partSize),
          0,
        );
      callbacks.onProgress(loaded, file.size);
      await Promise.all(
        missing.map((partNumber) =>
          partQueue.addTask(async () => {
            callbacks.signal.throwIfAborted();
            const start = (partNumber - 1) * session.partSize;
            const body = file.slice(start, Math.min(start + session.partSize, file.size));
            for (let attempt = 0; ; attempt++) {
              callbacks.signal.throwIfAborted();
              try {
                const signed = await this.sessionApi.sign(
                  { id: record.id, uploadSessionSignPartsDto: { partNumbers: [partNumber] } },
                  { signal: callbacks.signal },
                );
                const part = signed.parts.find((part) => part.partNumber === partNumber);
                if (!part) {
                  throw new DirectUploadError('upload_session_interrupted');
                }
                await this.putPart(part.url, body, callbacks.signal);
                loaded += body.size;
                callbacks.onProgress(loaded, file.size);
                return;
              } catch (error) {
                callbacks.signal.throwIfAborted();
                if (attempt >= 2) {
                  throw error;
                }
                await this.wait(callbacks.signal, 500 * 2 ** attempt);
              }
            }
          }),
        ),
      );
      callbacks.signal.throwIfAborted();
      session = await this.sessionApi.complete({ id: record.id }, { signal: callbacks.signal });
    }
    return this.poll(record, callbacks, session);
  }

  async poll(record: RememberedUpload, callbacks: UploadCallbacks, initial?: UploadSessionResponseDto) {
    let session = initial ?? (await this.status(record, callbacks.signal));
    for (;;) {
      callbacks.signal.throwIfAborted();
      callbacks.onState(session.state);
      switch (session.state) {
        case State.Committed:
        case State.Duplicate: {
          if (!session.result) {
            throw new DirectUploadError('upload_session_failed');
          }
          return session.result;
        }
        case State.Rejected:
        case State.Aborted:
        case State.Expired: {
          this.forget(record);
          throw new DirectUploadError('upload_session_failed');
        }
        case State.Uploading: {
          throw new DirectUploadError('upload_session_reselect');
        }
        case State.Initiating:
        case State.Finalizing:
        case State.Verifying:
        case State.Verified: {
          await this.wait(callbacks.signal);
          session = await this.status(record, callbacks.signal);
          break;
        }
        default: {
          const exhaustive: never = session.state;
          throw new Error(exhaustive);
        }
      }
    }
  }
}

export const directUploads = new DirectUploads();
