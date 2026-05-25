ALTER TABLE "chat_thread_runs" DROP CONSTRAINT IF EXISTS "chat_thread_runs_status_check";--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_status_check" CHECK ("chat_thread_runs"."status" in ('queued', 'running', 'cancel_requested', 'waiting_for_approval', 'completed', 'failed', 'cancelled'));--> statement-breakpoint
DROP INDEX IF EXISTS "chat_thread_runs_thread_active_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "chat_thread_runs_thread_active_uq" ON "chat_thread_runs" USING btree ("team_id","workspace_id","thread_id") WHERE "chat_thread_runs"."status" in ('queued', 'running', 'cancel_requested', 'waiting_for_approval');--> statement-breakpoint
