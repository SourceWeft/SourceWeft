ALTER TABLE "working_files" DROP CONSTRAINT "working_files_path_check";
--> statement-breakpoint
ALTER TABLE "working_files" ADD CONSTRAINT "working_files_path_check" CHECK ("path" ~ '^/files/[^[:cntrl:]]+$' and "path" not like '%..%' and "path" not like '%~%' and "path" not like '%//%');
