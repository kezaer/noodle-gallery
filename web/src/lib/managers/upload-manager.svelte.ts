import { getSupportedMediaTypes, type ServerMediaTypesResponseDto } from '@immich/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { uploadAssetsStore } from '$lib/stores/upload';
import { cancelUploadRequests } from '$lib/utils';
import { directUploads } from '$lib/utils/direct-upload';

class UploadManager {
  mediaTypes = $state<ServerMediaTypesResponseDto>({ image: [], sidecar: [], video: [] });

  constructor() {
    eventManager.on({
      AppInit: () => this.#loadExtensions(),
      AuthUserLoaded: () =>
        import('$lib/utils/file-uploader').then(({ restoreDirectUploads }) => restoreDirectUploads()),
      AuthLogout: () => this.reset(),
    });
  }

  reset() {
    directUploads.stopAll();
    cancelUploadRequests();
    uploadAssetsStore.reset();
  }

  async #loadExtensions() {
    try {
      this.mediaTypes = await getSupportedMediaTypes();
    } catch {
      console.error('Failed to load supported media types');
    }
  }

  getExtensions() {
    return [...this.mediaTypes.image, ...this.mediaTypes.video];
  }
}

export const uploadManager = new UploadManager();
