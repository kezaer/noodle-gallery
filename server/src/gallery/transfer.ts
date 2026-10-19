import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import z from 'zod';
import { AssetMediaResponseDto } from 'src/dtos/asset-media-response.dto.js';
import { UploadSessionCreateDto, UploadSessionStateSchema } from 'src/dtos/upload-session.dto.js';
import { JobName } from 'src/enum.js';
import { StoredPart } from 'src/interfaces/s3-multipart.interface.js';
import { JobItem } from 'src/types.js';

export type UploadState = z.infer<typeof UploadSessionStateSchema>;
export type UploadProgress =
  | { kind: 'initiating' }
  | { kind: 'uploading'; uploadId: string }
  | { kind: 'finalizing' | 'verifying'; uploadId: string; manifest: StoredPart[] }
  | { kind: 'verified'; uploadId: string; bytes: number; digest: string; stagePath: string | null }
  | { kind: 'committed'; result: AssetMediaResponseDto }
  | { kind: 'duplicate'; result: AssetMediaResponseDto; cleanup: 'pending' | 'done' }
  | {
      kind: 'aborted' | 'expired' | 'rejected';
      error: string;
      cleanup: { kind: 'pending'; uploadId: string | null } | { kind: 'done' };
    };

export type UploadSession = {
  id: string;
  ownerId: string;
  assetId: string;
  key: string;
  intent: UploadSessionCreateDto;
  progress: UploadProgress;
  partSize: number;
  expiresAt: Date;
  cancelRequested: boolean;
  claimToken: string | null;
  claimUntil: Date | null;
  eventDelivered: boolean;
  updatedAt: Date;
};

export type UploadJobContext = { assetId: string; token: string };
export const uploadJobContext = new AsyncLocalStorage<UploadJobContext>();
export const uploadJobToken = (assetId: string, item: JobItem) =>
  `gallery-upload-${assetId}-${createHash('sha256').update(JSON.stringify(item)).digest('hex')}`;

export const uploadIsTerminal = (progress: UploadProgress) =>
  ['committed', 'duplicate', 'aborted', 'expired', 'rejected'].includes(progress.kind);

export const validatePartManifest = (parts: StoredPart[], size: number, partSize: number) => {
  const count = Math.ceil(size / partSize);
  return (
    parts.length === count &&
    parts.every(
      (part, index) => part.partNumber === index + 1 && part.size === Math.min(partSize, size - index * partSize),
    )
  );
};

export const uploadGraphJobs = new Set<JobName>([
  JobName.AssetExtractMetadata,
  JobName.StorageTemplateMigrationSingle,
  JobName.AssetGenerateThumbnails,
  JobName.SmartSearch,
  JobName.AssetEncodeVideo,
  JobName.AssetDetectFaces,
  JobName.FacialRecognition,
  JobName.Ocr,
  JobName.PetDetection,
  JobName.PetRecognition,
  JobName.PersonGenerateThumbnail,
]);
