import { Readable } from 'node:stream';

export interface StoredPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface SignedPart {
  partNumber: number;
  url: string;
  expiresAt: string;
}

export interface S3MultipartStore {
  startMultipart(key: string, contentType: string): Promise<string>;
  listMultipartParts(key: string, uploadId: string): Promise<StoredPart[]>;
  signMultipartParts(key: string, uploadId: string, numbers: number[], expiresIn: number): Promise<SignedPart[]>;
  completeMultipart(key: string, uploadId: string, parts: StoredPart[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  headObject(key: string): Promise<{ bytes: number } | undefined>;
  readRange(key: string, start: number, length: number): Promise<Readable>;
}
