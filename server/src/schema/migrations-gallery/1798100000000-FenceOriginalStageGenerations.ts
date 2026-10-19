import { Kysely, sql } from 'kysely';
import { assertUploadTransfersDrained } from 'src/schema/migrations-gallery/1798000000000-AddUploadTransfers.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE gallery_original_stage ADD COLUMN generation uuid NOT NULL DEFAULT gen_random_uuid()`.execute(
    db,
  );
}

export async function down<T>(db: Kysely<T>): Promise<void> {
  await assertUploadTransfersDrained(db);
  await sql`ALTER TABLE gallery_original_stage DROP COLUMN generation`.execute(db);
}
