import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE gallery_original_stage ADD COLUMN generation uuid NOT NULL DEFAULT gen_random_uuid()`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE gallery_original_stage DROP COLUMN generation`.execute(db);
}
