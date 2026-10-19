import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  type Generated,
  Index,
  PrimaryColumn,
  Table,
  type Timestamp,
} from '@immich/sql-tools';
import type { UploadProgress } from 'src/gallery/transfer.js';
import type { JobItem } from 'src/types.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('gallery_upload_session')
@Index({ name: 'gallery_upload_session_owner_idx', columns: ['ownerId'] })
@Check({ name: 'gallery_upload_session_partSize_check', expression: '"partSize" >= 5242880' })
export class GalleryUploadSessionTable {
  @PrimaryColumn({ type: 'uuid' }) id!: string;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'NO ACTION', index: false }) ownerId!: string;
  @Column({ type: 'uuid', unique: true, uniqueConstraintName: 'gallery_upload_session_assetId_key' }) assetId!: string;
  @Column({ type: 'text', unique: true, uniqueConstraintName: 'gallery_upload_session_key_key' }) key!: string;
  @Column({ type: 'jsonb' }) intent!: unknown;
  @Column({ type: 'jsonb' }) progress!: UploadProgress;
  @Column({ type: 'integer' }) partSize!: number;
  @Column({ type: 'timestamp with time zone' }) expiresAt!: Timestamp;
  @Column({ type: 'boolean', default: false }) cancelRequested!: Generated<boolean>;
  @Column({ type: 'uuid', nullable: true }) claimToken!: string | null;
  @Column({ type: 'timestamp with time zone', nullable: true }) claimUntil!: Timestamp | null;
  @Column({ type: 'boolean', default: false }) eventDelivered!: Generated<boolean>;
  @Column({ type: 'boolean', default: false }) workflowsSnapshotted!: Generated<boolean>;
  @CreateDateColumn() updatedAt!: Generated<Timestamp>;
}

@Table('gallery_upload_reservation')
@Index({ name: 'gallery_upload_reservation_owner_idx', columns: ['ownerId'] })
@Check({ name: 'gallery_upload_reservation_bytes_check', expression: 'bytes > 0' })
export class GalleryUploadReservationTable {
  @PrimaryColumn({ type: 'uuid' }) id!: string;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'NO ACTION', index: false }) ownerId!: string;
  @Column({ type: 'double precision' }) bytes!: number;
  @Column({ type: 'timestamp with time zone' }) expiresAt!: Timestamp;
}

@Table('gallery_original_stage')
@Check({ name: 'gallery_original_stage_bytes_check', expression: 'bytes > 0' })
export class GalleryOriginalStageTable {
  @Column({ type: 'uuid', default: () => 'gen_random_uuid()' }) generation!: Generated<string>;
  @PrimaryColumn({ type: 'uuid' }) assetId!: string;
  @Column({ type: 'text', unique: true, uniqueConstraintName: 'gallery_original_stage_key_key' }) key!: string;
  @Column({ type: 'double precision' }) bytes!: number;
  @Column({ type: 'text', nullable: true }) path!: string | null;
  @Column({ type: 'uuid', nullable: true }) claimToken!: string | null;
  @Column({ type: 'timestamp with time zone', nullable: true }) claimUntil!: Timestamp | null;
  @Column({ type: 'timestamp with time zone' }) expiresAt!: Timestamp;
  @Column({ type: 'boolean', default: false }) retained!: Generated<boolean>;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
}

@Table('gallery_upload_job')
@Index({ name: 'gallery_upload_job_asset_idx', columns: ['assetId'] })
@Check({
  name: 'gallery_upload_job_state_check',
  expression: "state IN ('pending', 'accepted', 'success', 'skipped', 'failed')",
})
export class GalleryUploadJobTable {
  @PrimaryColumn({ type: 'text' }) token!: string;
  @ForeignKeyColumn(() => GalleryOriginalStageTable, { onDelete: 'CASCADE', onUpdate: 'NO ACTION', index: false })
  assetId!: string;
  @Column({ type: 'jsonb' }) item!: JobItem;
  @Column({ type: 'text' }) state!: 'pending' | 'accepted' | 'success' | 'skipped' | 'failed';
  @Column({ type: 'integer', default: 0 }) attempts!: Generated<number>;
  @CreateDateColumn() updatedAt!: Generated<Timestamp>;
}

@Table('gallery_stage_pin')
export class GalleryStagePinTable {
  @PrimaryColumn({ type: 'uuid' }) token!: string;
  @ForeignKeyColumn(() => GalleryOriginalStageTable, { onDelete: 'CASCADE', onUpdate: 'NO ACTION', index: false })
  assetId!: string;
  @Column({ type: 'timestamp with time zone' }) expiresAt!: Timestamp;
}

@Table('gallery_upload_workflow')
export class GalleryUploadWorkflowTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'NO ACTION', primary: true, index: false })
  assetId!: string;
  @PrimaryColumn({ type: 'uuid' }) workflowId!: string;
  @Column({ type: 'boolean', default: false }) accepted!: Generated<boolean>;
}
