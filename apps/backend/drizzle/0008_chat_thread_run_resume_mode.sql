ALTER TABLE "chat_thread_runs" DROP CONSTRAINT IF EXISTS "chat_thread_runs_mode_check";--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_mode_check" CHECK ("chat_thread_runs"."mode" in ('send', 'refresh', 'edit', 'resume'));--> statement-breakpoint
