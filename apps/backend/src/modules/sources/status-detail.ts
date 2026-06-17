import type {
  SourceRecord,
  SourceStatusDetail,
  SourceStatusStep,
} from "../content/types";

export function deriveStatusDetail(source: SourceRecord): SourceStatusDetail {
  const metadata = source.metadata ?? {};
  const status = source.status;
  const progress =
    typeof metadata.progress === "number" && Number.isFinite(metadata.progress)
      ? Math.max(0, Math.min(100, metadata.progress))
      : status === "indexed"
        ? 100
        : status === "failed"
          ? 100
          : status === "processing"
            ? 50
            : status === "queued"
              ? 10
              : 0;

  const currentStep =
    typeof metadata.currentStep === "string"
      ? (metadata.currentStep as SourceStatusStep)
      : status === "indexed"
        ? "completed"
        : status === "failed"
          ? "failed"
          : status === "processing"
            ? "parsing"
            : status === "queued"
              ? "queued"
              : "created";

  const parsedPages =
    typeof metadata.parsedPages === "number" ? metadata.parsedPages : null;
  const totalPages =
    typeof metadata.totalPages === "number"
      ? metadata.totalPages
      : source.estimatedPages;
  const error =
    typeof source.error?.message === "string"
      ? source.error.message
      : typeof metadata.error === "string"
        ? metadata.error
        : null;
  const jobId = typeof metadata.jobId === "string" ? metadata.jobId : null;

  return {
    status,
    progress,
    currentStep,
    parsedPages,
    totalPages,
    error,
    jobId,
  };
}
