CREATE TABLE "local_device_access" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"device_id" text NOT NULL,
	"native" boolean DEFAULT false NOT NULL,
	"token_hash" text,
	"policy_revision" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "local_device_enrollments" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "local_devices" ADD COLUMN "remote_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "local_devices" ADD COLUMN "policy_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "local_tool_invocations" ADD COLUMN "access_id" text;--> statement-breakpoint
ALTER TABLE "local_device_access" ADD CONSTRAINT "local_device_access_device_id_local_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."local_devices"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "local_folder_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "local_devices" ADD COLUMN "workspace_base" text;--> statement-breakpoint
ALTER TABLE "local_thread_bindings" ADD COLUMN "folder_id" text;--> statement-breakpoint
ALTER TABLE "local_folder_grants" ADD CONSTRAINT "local_folder_grants_device_id_local_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."local_devices"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE threads DROP CONSTRAINT threads_execution_target_check;
--> statement-breakpoint
ALTER TABLE threads ADD CONSTRAINT threads_execution_target_check CHECK (COALESCE((
 execution_target_json='{"kind":"cloud"}'::jsonb OR (
 execution_target_json->>'kind'='local' AND jsonb_typeof(execution_target_json->'deviceId')='string'
 AND (NOT execution_target_json ? 'folderId' OR jsonb_typeof(execution_target_json->'folderId')='string')
 AND (NOT execution_target_json ? 'directoryGrantId' OR (jsonb_typeof(execution_target_json->'directoryGrantId')='string' AND execution_target_json->>'directoryGrantId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'))
 AND NOT (execution_target_json ? 'folderId' AND execution_target_json ? 'directoryGrantId')
 AND (execution_target_json-'kind'-'deviceId'-'folderId'-'directoryGrantId')='{}'::jsonb
 )),false));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_local_thread_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root text; folder text; allocation text;
BEGIN
 IF NEW.execution_target_json->>'kind'='local' THEN
   folder := NEW.execution_target_json->>'folderId';
   allocation := gen_random_uuid()::text;
   IF folder IS NOT NULL THEN
     SELECT f.path INTO root FROM local_folder_grants f WHERE f.id=folder AND f.device_id=NEW.execution_target_json->>'deviceId' AND f.user_id=NEW.created_by AND f.revoked_at IS NULL;
     IF root IS NULL THEN RAISE EXCEPTION 'LOCAL_FOLDER_NOT_AUTHORIZED' USING ERRCODE='23514'; END IF;
   ELSIF NOT NEW.execution_target_json ? 'directoryGrantId' THEN
     SELECT d.workspace_base || '/' || allocation || '/files' INTO root FROM local_devices d WHERE d.id=NEW.execution_target_json->>'deviceId';
   END IF;
   INSERT INTO local_thread_bindings(thread_id,device_id,user_id,folder_id,local_workspace_id,workspace_path)
   VALUES(NEW.id,NEW.execution_target_json->>'deviceId',NEW.created_by,folder,CASE WHEN root IS NULL THEN NULL ELSE allocation END,root);
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_local_thread_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.created_by=NEW.user_id AND t.execution_target_json->>'kind'='local' AND t.execution_target_json->>'deviceId'=NEW.device_id AND (t.execution_target_json->>'folderId') IS NOT DISTINCT FROM NEW.folder_id) THEN
   RAISE EXCEPTION 'LOCAL_BINDING_TARGET_MISMATCH' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.thread_id IS DISTINCT FROM OLD.thread_id OR NEW.device_id IS DISTINCT FROM OLD.device_id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.folder_id IS DISTINCT FROM OLD.folder_id) THEN
   RAISE EXCEPTION 'EXECUTION_TARGET_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.local_workspace_id IS NOT NULL AND (NEW.local_workspace_id IS DISTINCT FROM OLD.local_workspace_id OR NEW.workspace_path IS DISTINCT FROM OLD.workspace_path) THEN
   RAISE EXCEPTION 'LOCAL_WORKSPACE_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF (NEW.local_workspace_id IS NULL) <> (NEW.workspace_path IS NULL) THEN
   RAISE EXCEPTION 'LOCAL_WORKSPACE_INCOMPLETE' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TABLE "local_creation_contexts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"target" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
