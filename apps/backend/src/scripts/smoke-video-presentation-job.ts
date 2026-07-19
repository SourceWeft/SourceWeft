/**
 * Smoke: create a pending video-presentation artifact, enqueue the deliverables
 * job, and poll DB until ready/failed (or timeout).
 *
 * Usage:
 *   pnpm exec tsx src/scripts/smoke-video-presentation-job.ts
 */
import { randomUUID } from "node:crypto";
import { buildVideoPresentationInitialPayload } from "@sourceweft/builtin-tool-video-presentation";
import { database } from "@sourceweft/db";
import { enqueueVideoPresentationGenerateJob } from "../modules/content/queue";

const WORKSPACE_ID = "add6b488-3ca7-4617-9eac-b163a9196f4e";
const TEAM_ID = "07b177a1-a271-4e66-bce6-39ffc42f5b1d";
const THREAD_ID = "d1e88f5a-adb8-4efc-9f13-709d0e2f7407";
const USER_ID = "3ecx0H6taD0jf1thbXbHzbnVOZihZBvj";
const POLL_MS = 3_000;
const TIMEOUT_MS = 8 * 60_000;

async function main() {
  const artifactId = randomUUID();
  const jobId = `video_presentation_render_${artifactId}`;
  const requestKey = `smoke:${artifactId}`;
  const title = "费曼学习法（smoke）";
  const brief =
    "用 4 页中文短视频介绍费曼学习法：选择概念、用简单语言讲解、发现漏洞、重新组织。语气清晰、适合初学者。";

  const request = {
    assets: [],
    brief,
    title,
    language: "zh",
    durationTarget: "short" as const,
    stylePreset: "cinematic" as const,
    slideCount: 4,
  };
  const payloadJson = buildVideoPresentationInitialPayload({
    artifactId,
    fileName: "feynman-smoke.json",
    jobId,
    request,
    requestKey,
    workspaceId: WORKSPACE_ID,
  });

  await database.query(
    `
    INSERT INTO artifacts (
      id, team_id, workspace_id, thread_id, artifact_type, status, title,
      prompt_text, payload_json, created_by, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, 'video_presentation', 'pending', $5,
      $6, $7::jsonb, $8, NOW(), NOW()
    )
    `,
    [
      artifactId,
      TEAM_ID,
      WORKSPACE_ID,
      THREAD_ID,
      title,
      brief,
      JSON.stringify(payloadJson),
      USER_ID,
    ],
  );

  const job = await enqueueVideoPresentationGenerateJob({
    artifactId,
    jobId,
    requestKey,
    teamId: TEAM_ID,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    userId: USER_ID,
    // Must reference a real messages.id — sandbox ops FK-enforce message_id.
    userMessageId: "run-user-4ee0edcd-8c76-40cf-b65a-30dad1760715",
    title,
    narrationEnabled: true,
    request,
  });

  console.log(
    JSON.stringify(
      {
        event: "enqueued",
        artifactId,
        jobId,
        queueJobId: job.id,
      },
      null,
      2,
    ),
  );

  const started = Date.now();
  while (Date.now() - started < TIMEOUT_MS) {
    const result = await database.query<{
      status: string;
      error_code: string | null;
      error_message: string | null;
      gen_status: string | null;
      stage: string | null;
      checkpoint: string | null;
      progress: string | null;
      steps: unknown;
    }>(
      `
      SELECT
        status,
        error_code,
        left(error_message, 180) AS error_message,
        payload_json->'generation'->>'status' AS gen_status,
        payload_json->'generation'->>'stage' AS stage,
        payload_json->'generation'->>'checkpointStage' AS checkpoint,
        payload_json->'generation'->>'progress' AS progress,
        payload_json->'generation'->'pipelineSteps' AS steps
      FROM artifacts
      WHERE id = $1
      `,
      [artifactId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`artifact missing: ${artifactId}`);
    }

    const stepSummary = Array.isArray(row.steps)
      ? row.steps.map((step) => {
          const record = step as Record<string, unknown>;
          return `${record.id}:${record.status}`;
        })
      : [];

    console.log(
      JSON.stringify({
        event: "poll",
        elapsedMs: Date.now() - started,
        status: row.status,
        gen_status: row.gen_status,
        stage: row.stage,
        checkpoint: row.checkpoint,
        progress: row.progress,
        error_code: row.error_code,
        error_message: row.error_message,
        steps: stepSummary,
      }),
    );

    if (row.status === "ready" || row.status === "failed") {
      console.log(
        JSON.stringify(
          {
            event: "done",
            artifactId,
            status: row.status,
            error_code: row.error_code,
            error_message: row.error_message,
          },
          null,
          2,
        ),
      );
      process.exit(row.status === "ready" ? 0 : 2);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  console.error(
    JSON.stringify({
      event: "timeout",
      artifactId,
      timeoutMs: TIMEOUT_MS,
    }),
  );
  process.exit(3);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
