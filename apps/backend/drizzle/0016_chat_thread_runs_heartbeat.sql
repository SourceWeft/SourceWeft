ALTER TABLE "chat_thread_runs" ADD COLUMN IF NOT EXISTS "heartbeat_at" timestamp with time zone;
