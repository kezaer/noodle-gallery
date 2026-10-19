import { ColumnType, Generated } from 'kysely';
import { AssetMediaResponseDto } from 'src/dtos/asset-media-response.dto.js';
import { UploadSessionCreateDto } from 'src/dtos/upload-session.dto.js';
import { UploadProgress } from 'src/gallery/transfer.js';
import { DB } from 'src/schema/index.js';
import { JobItem } from 'src/types.js';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type TransferDatabase = DB & {
  gallery_upload_session: {
    id: string;
    ownerId: string;
    assetId: string;
    key: string;
    intent: ColumnType<UploadSessionCreateDto, UploadSessionCreateDto, UploadSessionCreateDto>;
    progress: UploadProgress;
    partSize: number;
    expiresAt: Timestamp;
    cancelRequested: Generated<boolean>;
    claimToken: string | null;
    claimUntil: Timestamp | null;
    eventDelivered: Generated<boolean>;
    workflowsSnapshotted: Generated<boolean>;
    updatedAt: ColumnType<Date, Date | string | undefined, Date | string>;
  };
  gallery_upload_reservation: {
    id: string;
    ownerId: string;
    bytes: number;
    expiresAt: Timestamp;
  };
  gallery_original_stage: {
    assetId: string;
    generation: Generated<string>;
    key: string;
    bytes: number;
    path: string | null;
    claimToken: string | null;
    claimUntil: Timestamp | null;
    expiresAt: Timestamp;
    retained: Generated<boolean>;
    createdAt: ColumnType<Date, Date | string | undefined, Date | string>;
  };
  gallery_upload_job: {
    token: string;
    assetId: string;
    item: JobItem;
    state: 'pending' | 'accepted' | 'success' | 'skipped' | 'failed';
    attempts: Generated<number>;
    updatedAt: ColumnType<Date, Date | string | undefined, Date | string>;
  };
  gallery_stage_pin: {
    token: string;
    assetId: string;
    expiresAt: Timestamp;
  };
  gallery_upload_workflow: {
    assetId: string;
    workflowId: string;
    accepted: Generated<boolean>;
  };
};
export type VerifiedCommit = { response: AssetMediaResponseDto; claimed: boolean };
