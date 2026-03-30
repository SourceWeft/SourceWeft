import type {
  CancelJobResponse,
  CreateJobRequest,
  CreateJobResponse,
  JobDetailsResponse,
  JobEventsResponse,
} from "@polyer/contracts";
import { HttpClient } from "./http-client";

export class JobsClient {
  constructor(private readonly http: HttpClient) {}

  createJob(input: CreateJobRequest) {
    return this.http.post<CreateJobResponse>("/api/v1/jobs", input);
  }

  getJob(jobId: string) {
    return this.http.get<JobDetailsResponse>(
      `/api/v1/jobs/${encodeURIComponent(jobId)}`,
    );
  }

  cancelJob(jobId: string) {
    return this.http.post<CancelJobResponse>(
      `/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`,
    );
  }

  getJobEvents(jobId: string) {
    return this.http.get<JobEventsResponse>(
      `/api/v1/jobs/${encodeURIComponent(jobId)}/events`,
    );
  }
}
