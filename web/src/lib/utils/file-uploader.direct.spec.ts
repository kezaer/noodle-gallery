import {
  AssetMediaStatus,
  AssetUploadAction,
  AssetVisibility,
  checkBulkUpload,
  createUploadSession,
  getUploadSession,
  State,
  Status2,
  type ServerFeaturesDto,
  type UploadSessionResponseDto,
} from '@immich/sdk';
import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import { uploadManager } from '$lib/managers/upload-manager.svelte';
import { uploadAssetsStore } from '$lib/stores/upload';
import { UploadState } from '$lib/types';
import * as utils from '$lib/utils';
import { directUploads } from '$lib/utils/direct-upload';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import { fileUploadHandler } from './file-uploader';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  checkBulkUpload: vi.fn(),
  createUploadSession: vi.fn(),
  getUploadSession: vi.fn(),
}));

const features: ServerFeaturesDto = {
  configFile: false,
  directUpload: true,
  duplicateDetection: false,
  email: false,
  facialRecognition: false,
  importFaces: false,
  map: false,
  oauth: false,
  oauthAutoLaunch: false,
  ocr: false,
  passwordLogin: true,
  peopleStatistics: false,
  realtimeTranscoding: false,
  reverseGeocoding: false,
  search: false,
  sidecar: true,
  smartSearch: false,
  smartSearchHasCutoff: false,
  trash: true,
};
const checksum = 'a'.repeat(40);
const file = new File(['video'], 'video.mov', { lastModified: 100 });
const completed: UploadSessionResponseDto = {
  id: 'session',
  filename: file.name,
  size: file.size,
  checksum,
  partSize: 4,
  parts: [],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  state: State.Committed,
  result: { id: 'created-asset', status: Status2.Created },
};

describe('web direct upload selection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    directUploads.stopAll();
    localStorage.clear();
    uploadAssetsStore.reset();
    authManager.reset();
    authManager.setUser(userAdminFactory.build({ id: 'owner' }));
    authManager.setPreferences(preferencesFactory.build());
    vi.spyOn(uploadManager, 'getExtensions').mockReturnValue(['.mov']);
    vi.spyOn(featureFlagsManager, 'valueOrUndefined', 'get').mockReturnValue(features);
    vi.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(false);
    vi.mocked(checkBulkUpload).mockResolvedValue({ results: [] });
    vi.mocked(createUploadSession).mockResolvedValue(completed);
    vi.mocked(getUploadSession).mockResolvedValue(completed);
    vi.stubGlobal(
      'Worker',
      class {
        listener?: (event: { data: { result: string } }) => void;
        addEventListener(name: string, listener: (event: { data: { result: string } }) => void) {
          if (name === 'message') {
            this.listener = listener;
          }
        }
        postMessage() {
          queueMicrotask(() => this.listener?.({ data: { result: checksum } }));
        }
        terminate() {}
      },
    );
    vi.spyOn(utils, 'uploadRequest').mockResolvedValue({
      status: 201,
      data: { id: 'legacy-asset', status: AssetMediaStatus.Created },
    });
  });

  it('uses the generated session API for an eligible authenticated owner and preserves visibility', async () => {
    await expect(fileUploadHandler({ files: [file], isLockedAssets: true })).resolves.toEqual(['created-asset']);
    expect(createUploadSession).toHaveBeenCalledWith(
      {
        uploadSessionCreateDto: {
          filename: 'video.mov',
          size: 5,
          checksum,
          fileCreatedAt: '1970-01-01T00:00:00.100Z',
          fileModifiedAt: '1970-01-01T00:00:00.100Z',
          isFavorite: false,
          visibility: AssetVisibility.Locked,
        },
      },
      expect.anything(),
    );
    expect(utils.uploadRequest).not.toHaveBeenCalled();
    expect(get(uploadAssetsStore)[0].state).toBe(UploadState.DONE);
    expect(directUploads.list('owner')).toEqual([]);
  });

  it('reuses the restored row when the same file is selected through the main upload button', async () => {
    directUploads.remember({
      id: 'session',
      ownerId: 'owner',
      filename: file.name,
      size: file.size,
      lastModified: file.lastModified,
      checksum,
    });
    uploadAssetsStore.addItem({
      id: 'restored-row',
      directSessionId: 'session',
      file: { name: file.name, size: file.size, lastModified: file.lastModified },
    });
    await expect(fileUploadHandler({ files: [file] })).resolves.toEqual(['created-asset']);
    expect(createUploadSession).not.toHaveBeenCalled();
    expect(get(uploadAssetsStore)).toMatchObject([{ id: 'restored-row', state: UploadState.DONE }]);
    expect(get(uploadAssetsStore)).toHaveLength(1);
  });

  it.each([false, undefined])('keeps legacy upload when the direct flag is %s', async (flag) => {
    vi.spyOn(featureFlagsManager, 'valueOrUndefined', 'get').mockReturnValue(
      flag === undefined ? undefined : { ...features, directUpload: flag },
    );
    await expect(fileUploadHandler({ files: [file] })).resolves.toEqual(['legacy-asset']);
    expect(utils.uploadRequest).toHaveBeenCalledOnce();
    expect(createUploadSession).not.toHaveBeenCalled();
  });

  it('keeps shared links on the legacy upload path', async () => {
    vi.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(true);
    await expect(fileUploadHandler({ files: [file] })).resolves.toEqual(['legacy-asset']);
    expect(checkBulkUpload).not.toHaveBeenCalled();
    expect(createUploadSession).not.toHaveBeenCalled();
  });

  it('keeps anonymous upload on the legacy path', async () => {
    authManager.reset();
    await expect(fileUploadHandler({ files: [file] })).resolves.toEqual(['legacy-asset']);
    expect(createUploadSession).not.toHaveBeenCalled();
  });

  it('honors duplicate preflight before creating a session', async () => {
    vi.mocked(checkBulkUpload).mockResolvedValue({
      results: [{ id: file.name, action: AssetUploadAction.Reject, assetId: 'duplicate', isTrashed: true }],
    });
    await expect(fileUploadHandler({ files: [file] })).resolves.toEqual(['duplicate']);
    expect(createUploadSession).not.toHaveBeenCalled();
    expect(utils.uploadRequest).not.toHaveBeenCalled();
    expect(get(uploadAssetsStore)[0]).toMatchObject({ state: UploadState.DUPLICATED, isTrashed: true });
  });
});
