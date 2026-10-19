import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE gallery_upload_session (
      id uuid PRIMARY KEY,
      "ownerId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      "assetId" uuid NOT NULL UNIQUE,
      key text NOT NULL UNIQUE,
      intent jsonb NOT NULL,
      progress jsonb NOT NULL,
      "partSize" integer NOT NULL CHECK ("partSize" >= 5242880),
      "expiresAt" timestamptz NOT NULL,
      "cancelRequested" boolean NOT NULL DEFAULT false,
      "claimToken" uuid,
      "claimUntil" timestamptz,
      "eventDelivered" boolean NOT NULL DEFAULT false,
      "workflowsSnapshotted" boolean NOT NULL DEFAULT false,
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX gallery_upload_session_owner_idx ON gallery_upload_session("ownerId");
    CREATE TABLE gallery_upload_reservation (
      id uuid PRIMARY KEY,
      "ownerId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      bytes double precision NOT NULL CHECK (bytes > 0),
      "expiresAt" timestamptz NOT NULL
    );
    CREATE INDEX gallery_upload_reservation_owner_idx ON gallery_upload_reservation("ownerId");
    CREATE TABLE gallery_original_stage (
      "assetId" uuid PRIMARY KEY,
      key text NOT NULL UNIQUE,
      bytes double precision NOT NULL CHECK (bytes > 0),
      path text,
      "claimToken" uuid,
      "claimUntil" timestamptz,
      "expiresAt" timestamptz NOT NULL,
      retained boolean NOT NULL DEFAULT false,
      "createdAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE gallery_upload_job (
      token text PRIMARY KEY,
      "assetId" uuid NOT NULL REFERENCES gallery_original_stage("assetId") ON DELETE CASCADE,
      item jsonb NOT NULL,
      state text NOT NULL CHECK (state IN ('pending', 'accepted', 'success', 'skipped', 'failed')),
      attempts integer NOT NULL DEFAULT 0,
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX gallery_upload_job_asset_idx ON gallery_upload_job("assetId");
    CREATE TABLE gallery_stage_pin (
      token uuid PRIMARY KEY,
      "assetId" uuid NOT NULL REFERENCES gallery_original_stage("assetId") ON DELETE CASCADE,
      "expiresAt" timestamptz NOT NULL
    );
    CREATE TABLE gallery_upload_workflow (
      "assetId" uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
      "workflowId" uuid NOT NULL,
      accepted boolean NOT NULL DEFAULT false,
      PRIMARY KEY ("assetId", "workflowId")
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE gallery_upload_workflow;
    DROP TABLE gallery_stage_pin;
    DROP TABLE gallery_upload_job;
    DROP TABLE gallery_original_stage;
    DROP TABLE gallery_upload_reservation;
    DROP TABLE gallery_upload_session;
  `.execute(db);
}
