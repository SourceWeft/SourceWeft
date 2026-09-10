ALTER TABLE "threads" ADD COLUMN "source_selection_json" jsonb DEFAULT '{"revision":0,"selectedSourceIds":[]}'::jsonb NOT NULL;
