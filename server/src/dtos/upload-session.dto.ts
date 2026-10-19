import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { AssetMetadataUpsertItemSchema } from 'src/dtos/asset.dto.js';
import { AssetVisibilitySchema } from 'src/enum.js';
import { isoDatetimeToDate } from 'src/validation.js';

export const UploadSessionCreateSchema = z
  .object({
    filename: z.string().min(1).max(255),
    size: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 ** 4),
    checksum: z.string().regex(/^[a-fA-F0-9]{40}$/, 'Expected a hex SHA-1 checksum'),
    fileCreatedAt: isoDatetimeToDate,
    fileModifiedAt: isoDatetimeToDate,
    duration: z.number().int().nonnegative().optional(),
    isFavorite: z.boolean().optional(),
    visibility: AssetVisibilitySchema.optional(),
    metadata: z.array(AssetMetadataUpsertItemSchema).max(100).optional(),
  })
  .meta({ id: 'UploadSessionCreateDto' });

export const UploadSessionStateSchema = z.enum([
  'initiating',
  'uploading',
  'finalizing',
  'verifying',
  'verified',
  'committed',
  'duplicate',
  'rejected',
  'aborted',
  'expired',
]);

const UploadSessionPartSchema = z
  .object({
    partNumber: z.number().int(),
    etag: z.string(),
    size: z.number().int(),
  })
  .meta({ id: 'UploadSessionPartDto' });

const UploadSessionResponseSchema = z
  .object({
    id: z.uuid(),
    state: UploadSessionStateSchema,
    filename: z.string(),
    size: z.number().int(),
    checksum: z.string(),
    partSize: z.number().int(),
    expiresAt: z.string(),
    parts: z.array(UploadSessionPartSchema),
    result: z.object({ id: z.uuid(), status: z.enum(AssetMediaStatus) }).optional(),
    error: z.string().optional(),
  })
  .meta({ id: 'UploadSessionResponseDto' });

const UploadSessionSignPartsSchema = z
  .object({
    partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100),
  })
  .meta({ id: 'UploadSessionSignPartsDto' });

const UploadSessionSignedPartsSchema = z
  .object({
    parts: z.array(z.object({ partNumber: z.number().int(), url: z.string(), expiresAt: z.string() })),
  })
  .meta({ id: 'UploadSessionSignedPartsDto' });

export class UploadSessionCreateDto extends createZodDto(UploadSessionCreateSchema) {}
export class UploadSessionResponseDto extends createZodDto(UploadSessionResponseSchema) {}
export class UploadSessionSignPartsDto extends createZodDto(UploadSessionSignPartsSchema) {}
export class UploadSessionSignedPartsDto extends createZodDto(UploadSessionSignedPartsSchema) {}
