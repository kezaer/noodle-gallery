import {
  AssetMediaStatus,
  AssetUploadAction,
  AssetVisibility,
  checkBulkUpload,
  getBaseUrl,
  State,
  type AssetMediaResponseDto,
} from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { tick } from 'svelte';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import { uploadManager } from '$lib/managers/upload-manager.svelte';
import { addAssetsToAlbums } from '$lib/services/album.service';
import { uploadAssetsStore } from '$lib/stores/upload';
import { UploadState } from '$lib/types';
import { uploadRequest } from '$lib/utils';
import { directUploads, DirectUploadError, type RememberedUpload } from '$lib/utils/direct-upload';
import { ExecutorQueue } from '$lib/utils/executor-queue';
import { asQueryString } from '$lib/utils/shared-links';
import { handleError } from './handle-error';

export const uploadExecutionQueue = new ExecutorQueue({ concurrency: 2 });

type FilePickerParam = { multiple?: boolean; extensions?: string[] };
type FileUploadParam = { multiple?: boolean; albumId?: string };

export const openFilePicker = async (options: FilePickerParam = {}) => {
  const { multiple = true, extensions } = options;

  return new Promise<File[]>((resolve, reject) => {
    try {
      const fileSelector = document.createElement('input');

      fileSelector.type = 'file';
      fileSelector.multiple = multiple;

      if (extensions) {
        fileSelector.accept = extensions.join(',');
      }

      fileSelector.addEventListener(
        'change',
        (e: Event) => {
          fileSelector.remove();

          const target = e.target as HTMLInputElement;
          if (!target.files) {
            return;
          }

          const files = Array.from(target.files);
          resolve(files);
        },
        { passive: true },
      );

      fileSelector.addEventListener(
        'cancel',
        () => {
          fileSelector.remove();
          resolve([]);
        },
        { passive: true },
      );

      // Safari requires the file selector to be mounted
      fileSelector.hidden = true;
      document.body.append(fileSelector);
      fileSelector.click();
    } catch (error) {
      console.log('Error selecting file', error);
      reject(error);
    }
  });
};

export const openFileUploadDialog = async (options: FileUploadParam = {}) => {
  const { albumId, multiple = true } = options;
  const extensions = uploadManager.getExtensions();
  const files = await openFilePicker({
    multiple,
    extensions,
  });

  return fileUploadHandler({ files, albumId });
};

type FileUploadHandlerParams = Omit<FileUploaderParams, 'deviceAssetId' | 'assetFile' | 'resume'> & {
  files: File[];
};

export const fileUploadHandler = async ({
  files,
  albumId,
  isLockedAssets = false,
}: FileUploadHandlerParams): Promise<string[]> => {
  const extensions = uploadManager.getExtensions();
  const promises = [];
  const generation = directUploads.generation;
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (extensions.some((extension) => name.endsWith(extension))) {
      const record = findRememberedUpload(file);
      const existing = record && get(uploadAssetsStore).find((item) => item.directSessionId === record.id);
      const deviceAssetId = existing?.id ?? getDeviceAssetId(file);
      uploadAssetsStore.addItem({ id: deviceAssetId, file, albumId, directSessionId: record?.id });
      promises.push(
        uploadExecutionQueue.addTask(() =>
          generation === directUploads.generation
            ? fileUploader({ deviceAssetId, assetFile: file, albumId, isLockedAssets, resume: record })
            : Promise.resolve(undefined),
        ),
      );
    } else {
      toastManager.warning(get(t)('unsupported_file_type', { values: { file: file.name, type: file.type } }), {
        timeout: 10_000,
      });
    }
  }

  const results = await Promise.all(promises);
  return results.filter((result): result is string => !!result);
};

function getDeviceAssetId(asset: File) {
  return 'web-' + asset.name + '-' + asset.lastModified;
}

function findRememberedUpload(file: File) {
  if (!authManager.authenticated || authManager.isSharedLink) {
    return;
  }
  return directUploads
    .list(authManager.user.id)
    .find(
      (record) =>
        record.filename === file.name && record.size === file.size && record.lastModified === file.lastModified,
    );
}

function hashFile(file: File, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(new URL('$lib/workers/hash-file.ts', import.meta.url), { type: 'module' });

    const abort = () => {
      worker.terminate();
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });

    worker.addEventListener('message', ({ data }: MessageEvent<{ result?: string; error?: string }>) => {
      worker.terminate();
      signal?.removeEventListener('abort', abort);

      if (data.error) {
        reject(new Error(data.error));
      } else {
        resolve(data.result!);
      }
    });

    worker.addEventListener('error', (event) => {
      worker.terminate();
      signal?.removeEventListener('abort', abort);

      reject(new Error(event.message));
    });

    worker.postMessage(file);
  });
}

type FileUploaderParams = {
  assetFile: File;
  albumId?: string;
  replaceAssetId?: string;
  isLockedAssets?: boolean;
  // TODO rework the asset uploader and remove this
  deviceAssetId: string;
  resume?: RememberedUpload;
};

// TODO: should probably use the @api SDK
async function fileUploader({
  assetFile,
  deviceAssetId,
  albumId,
  isLockedAssets = false,
  resume,
}: FileUploaderParams): Promise<string | undefined> {
  const fileCreatedAt = new Date(assetFile.lastModified).toISOString();
  const $t = get(t);
  const wasInitiallyLoggedIn = !!authManager.authenticated;

  const controller = directUploads.start(deviceAssetId);
  uploadAssetsStore.markStarted(deviceAssetId);

  try {
    const formData = new FormData();
    for (const [key, value] of Object.entries({
      fileCreatedAt,
      fileModifiedAt: new Date(assetFile.lastModified).toISOString(),
      isFavorite: 'false',
      assetData: new File([assetFile], assetFile.name),
    })) {
      formData.append(key, value);
    }

    if (isLockedAssets) {
      formData.append('visibility', AssetVisibility.Locked);
    }

    let checksum: string | undefined;
    let record = resume;
    let responseData: { id: string; status: AssetMediaStatus; isTrashed?: boolean } | undefined;
    if (!authManager.isSharedLink) {
      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_hashing') });
      await tick();
      try {
        checksum = await hashFile(assetFile, controller.signal);
        record ??= findRememberedUpload(assetFile);

        const {
          results: [checkUploadResult],
        } = await checkBulkUpload({ assetBulkUploadCheckDto: { assets: [{ id: assetFile.name, checksum }] } });
        if (
          !record &&
          checkUploadResult &&
          checkUploadResult.action === AssetUploadAction.Reject &&
          checkUploadResult.assetId
        ) {
          responseData = {
            status: AssetMediaStatus.Duplicate,
            id: checkUploadResult.assetId,
            isTrashed: checkUploadResult.isTrashed,
          };
        }
      } catch (error) {
        console.error(`Error calculating sha1 file=${assetFile.name})`, error);
      }
    }

    controller.signal.throwIfAborted();
    if (record) {
      uploadAssetsStore.updateItem(deviceAssetId, { directSessionId: record.id });
    }
    if (record && !checksum) {
      throw new DirectUploadError('upload_session_file_mismatch');
    }
    if (
      !responseData &&
      checksum &&
      authManager.authenticated &&
      !authManager.isSharedLink &&
      (record ||
        (featureFlagsManager.valueOrUndefined?.directUpload === true &&
          assetFile.size > 0 &&
          uploadManager.getExtensions().some((extension) => assetFile.name.toLowerCase().endsWith(extension))))
    ) {
      record ??= await directUploads.create(
        authManager.user.id,
        assetFile,
        {
          filename: assetFile.name,
          size: assetFile.size,
          checksum,
          fileCreatedAt,
          fileModifiedAt: fileCreatedAt,
          isFavorite: false,
          visibility: isLockedAssets ? AssetVisibility.Locked : undefined,
        },
        albumId,
        controller.signal,
      );
      uploadAssetsStore.updateItem(deviceAssetId, { directSessionId: record.id });
      directUploads.attach(record.id, controller);
      const result = await directUploads.transfer(record, assetFile, checksum, {
        signal: controller.signal,
        onProgress: (loaded, total) => uploadAssetsStore.updateProgress(deviceAssetId, loaded, total),
        onState: (state) =>
          uploadAssetsStore.updateItem(deviceAssetId, {
            message: $t(state === State.Uploading ? 'asset_uploading' : 'upload_session_verifying'),
          }),
      });
      responseData = {
        ...result,
        status: result.status === 'duplicate' ? AssetMediaStatus.Duplicate : AssetMediaStatus.Created,
      };
    }

    if (!responseData) {
      const queryParams = asQueryString(authManager.params);

      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_uploading') });
      const response = await uploadRequest<AssetMediaResponseDto>({
        url: getBaseUrl() + '/assets' + (queryParams ? `?${queryParams}` : ''),
        data: formData,
        onUploadProgress: (event) => uploadAssetsStore.updateProgress(deviceAssetId, event.loaded, event.total),
      });

      if (![200, 201].includes(response.status)) {
        throw new Error($t('errors.unable_to_upload_file'));
      }

      responseData = response.data;
    }

    await finishUpload(deviceAssetId, responseData, record?.albumId ?? albumId, controller.signal);
    if (record) {
      directUploads.forget(record);
    }
    return responseData.id;
  } catch (error) {
    // If the user store no longer holds a user, it means they have logged out
    // In this case don't bother reporting any errors.
    if (wasInitiallyLoggedIn && !authManager.authenticated) {
      return;
    }

    if (controller.signal.aborted) {
      return;
    }
    directUploads.stop(deviceAssetId);
    const directSessionId = get(uploadAssetsStore).find((item) => item.id === deviceAssetId)?.directSessionId;
    if (directSessionId) {
      pauseDirectUpload(deviceAssetId, error);
      return;
    }
    const errorMessage = handleError(error, $t('errors.unable_to_upload_file'));
    uploadAssetsStore.track('error');
    uploadAssetsStore.updateItem(deviceAssetId, { state: UploadState.ERROR, error: errorMessage });
    return;
  } finally {
    directUploads.release(controller);
  }
}

async function finishUpload(
  id: string,
  response: Pick<AssetMediaResponseDto, 'id' | 'status'> & { isTrashed?: boolean },
  albumId?: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const $t = get(t);
  if (albumId && !authManager.isSharedLink) {
    uploadAssetsStore.updateItem(id, { message: $t('asset_adding_to_album') });
    await addAssetsToAlbums([albumId], [response.id], { notify: false });
  }
  signal?.throwIfAborted();
  uploadAssetsStore.track(response.status === AssetMediaStatus.Duplicate ? 'duplicate' : 'success');
  uploadAssetsStore.updateItem(id, {
    state: response.status === AssetMediaStatus.Duplicate ? UploadState.DUPLICATED : UploadState.DONE,
    assetId: response.id,
    isTrashed: response.isTrashed,
  });
  if (response.status !== AssetMediaStatus.Duplicate) {
    setTimeout(() => uploadAssetsStore.removeItem(id), 1000);
  }
}

function pauseDirectUpload(id: string, error: unknown) {
  const message = get(t)(error instanceof DirectUploadError ? error.key : 'upload_session_interrupted');
  if (error instanceof DirectUploadError && error.key === 'upload_session_failed') {
    uploadAssetsStore.track('error');
    uploadAssetsStore.updateItem(id, { state: UploadState.ERROR, error: message, directSessionId: undefined });
    return;
  }
  uploadAssetsStore.updateItem(id, { state: UploadState.PAUSED, message });
}

async function watchDirectUpload(
  id: string,
  record: RememberedUpload,
  controller: AbortController,
  session: Awaited<ReturnType<typeof directUploads.status>>,
) {
  uploadAssetsStore.markStarted(id);
  try {
    const result = await directUploads.poll(
      record,
      {
        signal: controller.signal,
        onProgress: () => {},
        onState: () => uploadAssetsStore.updateItem(id, { message: get(t)('upload_session_verifying') }),
      },
      session,
    );
    await finishUpload(
      id,
      {
        ...result,
        status: result.status === 'duplicate' ? AssetMediaStatus.Duplicate : AssetMediaStatus.Created,
      },
      record.albumId,
      controller.signal,
    );
    directUploads.forget(record);
    return result.id;
  } catch (error) {
    if (!controller.signal.aborted) {
      pauseDirectUpload(id, error);
    }
  } finally {
    directUploads.release(controller);
  }
}

export async function restoreDirectUploads() {
  if (!authManager.authenticated || authManager.isSharedLink) {
    return;
  }
  const ownerId = authManager.user.id;
  for (const record of directUploads.list(ownerId)) {
    const id = `direct-${record.id}`;
    if (get(uploadAssetsStore).some((item) => item.directSessionId === record.id)) {
      continue;
    }
    uploadAssetsStore.addItem({
      id,
      file: { name: record.filename, size: record.size, lastModified: record.lastModified },
      albumId: record.albumId,
      directSessionId: record.id,
    });
    const controller = directUploads.start(record.id);
    try {
      const session = await directUploads.status(record, controller.signal);
      controller.signal.throwIfAborted();
      if (session.state === State.Uploading) {
        uploadAssetsStore.updateItem(id, { state: UploadState.PAUSED, message: get(t)('upload_session_reselect') });
        directUploads.release(controller);
        continue;
      }
      void watchDirectUpload(id, record, controller, session);
    } catch (error) {
      if (!controller.signal.aborted) {
        pauseDirectUpload(id, error);
      }
      directUploads.release(controller);
    }
  }
}

export async function resumeDirectUpload(id: string) {
  const item = get(uploadAssetsStore).find((item) => item.id === id);
  if (!item?.directSessionId || !authManager.authenticated) {
    return;
  }
  const record = directUploads.list(authManager.user.id).find((record) => record.id === item.directSessionId);
  if (!record) {
    return;
  }
  const controller = directUploads.start(record.id);
  const generation = directUploads.generation;
  try {
    const session = await directUploads.status(record, controller.signal);
    controller.signal.throwIfAborted();
    if (session.state !== State.Uploading) {
      return await watchDirectUpload(id, record, controller, session);
    }
    const [file] = await openFilePicker({ multiple: false });
    if (!file || controller.signal.aborted) {
      return;
    }
    uploadAssetsStore.updateItem(id, { file });
    return await uploadExecutionQueue.addTask(() =>
      generation === directUploads.generation
        ? fileUploader({ deviceAssetId: id, assetFile: file, albumId: record.albumId, resume: record })
        : Promise.resolve(undefined),
    );
  } catch (error) {
    if (!controller.signal.aborted) {
      pauseDirectUpload(id, error);
    }
  } finally {
    directUploads.release(controller);
  }
}

export async function cancelDirectUpload(id: string) {
  const item = get(uploadAssetsStore).find((item) => item.id === id);
  if (!item?.directSessionId || !authManager.authenticated) {
    return;
  }
  const record = directUploads.list(authManager.user.id).find((record) => record.id === item.directSessionId);
  if (!record) {
    return;
  }
  try {
    const session = await directUploads.cancel(record);
    if (!authManager.authenticated || authManager.user.id !== record.ownerId) {
      return;
    }
    if (session.result && (session.state === State.Committed || session.state === State.Duplicate)) {
      await finishUpload(
        id,
        {
          ...session.result,
          status: session.result.status === 'duplicate' ? AssetMediaStatus.Duplicate : AssetMediaStatus.Created,
        },
        record.albumId,
      );
      return;
    }
    uploadAssetsStore.updateItem(id, { state: UploadState.PAUSED });
    uploadAssetsStore.removeItem(id);
  } catch {
    uploadAssetsStore.updateItem(id, { state: UploadState.PAUSED, message: get(t)('upload_session_cancel_failed') });
  }
}
