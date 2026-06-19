ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_artifact_type_check";
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_artifact_type_check" CHECK ("artifacts"."artifact_type" in ('file', 'report', 'slides', 'mindmap', 'podcast', 'audio_overview', 'video_overview', 'video_presentation', 'flashcards', 'quiz', 'table', 'infographic', 'image'));
