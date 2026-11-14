-- A saved answer's note row now goes with its note source (Issue #496). Before,
-- deleting the source left the row behind with a null source, and saving the
-- same answer again returned that dead row instead of making a new note. Rows
-- already in that state are removed first: nothing can open them.
DELETE FROM "notes" WHERE "note_type" = 'saved_response' AND "source_id" IS NULL;--> statement-breakpoint
-- Saved notes are editable from now on.
UPDATE "notes" SET "is_editable" = true WHERE "note_type" = 'saved_response';--> statement-breakpoint
ALTER TABLE "notes" DROP CONSTRAINT "notes_source_id_sources_id_fk";
--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;