ALTER TABLE "threads" ADD COLUMN "execution_target_json" jsonb DEFAULT '{"kind":"cloud"}'::jsonb NOT NULL;
--> statement-breakpoint
-- Preserve any pre-release local bindings before enforcing immutability.
UPDATE threads t SET execution_target_json = jsonb_build_object('kind','local','deviceId',b.device_id)
FROM local_thread_bindings b WHERE b.thread_id=t.id;
--> statement-breakpoint
ALTER TABLE threads ADD CONSTRAINT threads_execution_target_check CHECK (COALESCE((
  execution_target_json = '{"kind":"cloud"}'::jsonb OR (
    execution_target_json->>'kind'='local'
    AND jsonb_typeof(execution_target_json->'deviceId')='string'
    AND execution_target_json = jsonb_build_object('kind','local','deviceId',execution_target_json->>'deviceId')
  )
), false));
--> statement-breakpoint
CREATE FUNCTION protect_thread_execution_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.execution_target_json IS DISTINCT FROM OLD.execution_target_json THEN
    RAISE EXCEPTION 'EXECUTION_TARGET_IMMUTABLE: create a new conversation' USING ERRCODE='23514';
  END IF;
  IF NEW.execution_target_json->>'kind'='local' THEN
    IF NEW.visibility <> 'private' OR NEW.created_by IS NULL THEN
      RAISE EXCEPTION 'LOCAL_THREAD_MUST_BE_PRIVATE' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND (NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.team_id IS DISTINCT FROM OLD.team_id) THEN
      RAISE EXCEPTION 'LOCAL_THREAD_SCOPE_IMMUTABLE' USING ERRCODE='23514';
    END IF;
    IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM local_devices d WHERE d.id=NEW.execution_target_json->>'deviceId' AND d.user_id=NEW.created_by AND d.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'LOCAL_DEVICE_NOT_OWNED' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER threads_execution_target_immutable BEFORE INSERT OR UPDATE ON threads
FOR EACH ROW EXECUTE FUNCTION protect_thread_execution_target();
--> statement-breakpoint
CREATE FUNCTION create_local_thread_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_target_json->>'kind'='local' THEN
    INSERT INTO local_thread_bindings(thread_id,device_id,user_id)
    VALUES(NEW.id,NEW.execution_target_json->>'deviceId',NEW.created_by);
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER threads_create_local_binding AFTER INSERT ON threads
FOR EACH ROW EXECUTE FUNCTION create_local_thread_binding();
--> statement-breakpoint
CREATE FUNCTION protect_local_thread_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.created_by=NEW.user_id AND t.execution_target_json=jsonb_build_object('kind','local','deviceId',NEW.device_id)) THEN
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
--> statement-breakpoint
CREATE TRIGGER local_thread_binding_immutable BEFORE INSERT OR UPDATE ON local_thread_bindings
FOR EACH ROW EXECUTE FUNCTION protect_local_thread_binding();
