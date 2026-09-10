-- A native-issued opaque grant selects a directory; raw paths are never accepted.
ALTER TABLE threads DROP CONSTRAINT threads_execution_target_check;
--> statement-breakpoint
ALTER TABLE threads ADD CONSTRAINT threads_execution_target_check CHECK (COALESCE((
  execution_target_json = '{"kind":"cloud"}'::jsonb OR (
    execution_target_json->>'kind'='local'
    AND jsonb_typeof(execution_target_json->'deviceId')='string'
    AND (
      execution_target_json = jsonb_build_object('kind','local','deviceId',execution_target_json->>'deviceId')
      OR (
        jsonb_typeof(execution_target_json->'directoryGrantId')='string'
        AND execution_target_json->>'directoryGrantId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND execution_target_json = jsonb_build_object('kind','local','deviceId',execution_target_json->>'deviceId','directoryGrantId',execution_target_json->>'directoryGrantId')
      )
    )
  )
), false));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_local_thread_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.created_by=NEW.user_id AND t.execution_target_json->>'kind'='local' AND t.execution_target_json->>'deviceId'=NEW.device_id) THEN
    RAISE EXCEPTION 'LOCAL_BINDING_TARGET_MISMATCH' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.thread_id IS DISTINCT FROM OLD.thread_id OR NEW.device_id IS DISTINCT FROM OLD.device_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
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
