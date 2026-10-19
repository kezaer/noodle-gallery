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

export async function assertUploadTransfersDrained<T>(db: Kysely<T>): Promise<void> {
  await sql`
    LOCK TABLE gallery_upload_session, gallery_upload_reservation, gallery_original_stage,
      gallery_upload_job, gallery_stage_pin, gallery_upload_workflow IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM gallery_upload_session WHERE progress->>'kind' NOT IN
          ('committed', 'duplicate', 'rejected', 'aborted', 'expired') OR progress->>'cleanup' = 'pending'
          OR progress->'cleanup'->>'kind' = 'pending')
        OR EXISTS (SELECT 1 FROM gallery_upload_job WHERE state IN ('pending', 'accepted'))
        OR EXISTS (SELECT 1 FROM gallery_stage_pin WHERE "expiresAt" > now())
        OR EXISTS (SELECT 1 FROM gallery_original_stage WHERE retained OR "claimUntil" > now())
        OR EXISTS (SELECT 1 FROM gallery_upload_workflow WHERE NOT accepted)
        OR EXISTS (SELECT 1 FROM gallery_upload_reservation WHERE "expiresAt" > now())
        OR EXISTS (SELECT 1 FROM gallery_upload_session WHERE progress->>'kind' = 'committed' AND NOT "eventDelivered")
      THEN RAISE EXCEPTION 'Drain uploads, dispatch, processing, reservations and stages before reverting upload transfers';
      END IF;
    END $$;
  `.execute(db);
}

export async function down<T>(db: Kysely<T>): Promise<void> {
  await assertUploadTransfersDrained(db);
  await sql`
    DROP TABLE gallery_upload_workflow;
    DROP TABLE gallery_stage_pin;
    DROP TABLE gallery_upload_job;
    DROP TABLE gallery_original_stage;
    DROP TABLE gallery_upload_reservation;
    DROP TABLE gallery_upload_session;
  `.execute(db);
}
