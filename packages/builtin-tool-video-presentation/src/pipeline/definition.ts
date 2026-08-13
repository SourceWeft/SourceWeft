import {
  DeliverablePipelineError,
  type CreateDeliverablePipelines,
  type DeliverablePipelineDefinition,
} from "@sourceweft/capability-contracts";
import { truncatePipelineSummary } from "@sourceweft/contracts/artifact-pipeline";
import {
  computeVideoPresentationOverallProgress,
  videoPresentationCreateRequestSchema,
  videoPresentationProjectPayloadSchema,
  VIDEO_PRESENTATION_ERROR_CODES,
  type VideoPresentationCreateRequest,
  type VideoPresentationPipelineStageId,
  type VideoPresentationPipelineStep,
  type VideoPresentationProjectPayload,
} from "@sourceweft/contracts/video-presentation";
import { VIDEO_PRESENTATION_PIPELINE_JOB_NAME } from "../artifact-records";
import { buildVideoPresentationStageView } from "../pipeline-digests";
import { generateAudioTracks } from "./audio";
import { MAX_ERROR_MESSAGE_LENGTH } from "./config";
import { createVideoPipelineDeps, type VideoPipelineDeps } from "./deps";
import { attachReadySourceJson } from "./finalize";
import { uploadCoverImage } from "./preview-images";
import {
  runGeneratedProject,
  type RenderedVideoResult,
} from "./sandbox-project";
import {
  generateSceneModules,
  repairSceneModules,
  runVisualQualityCheck,
} from "./scene-gen";
import {
  editTargetSlideNumbers,
  resolveVideoEditPlan,
} from "./edit-plan";
import { videoPipelineStages } from "./stages";
import {
  materializeAssets,
  planVideoProject,
  regenerateStoryboardSlides,
} from "./storyboard";
import { assignSlideThemes } from "./themes";
import { normalizeProjectExecutionResults, truncateText } from "./util";

// Instantiated with the real render result rather than the default type
// parameter: the publishing stage reads `video.report` off what it finds in
// scratch, so the mp4's shape has to survive the round trip through `scratch`.
type ProjectRunResults = ReturnType<
  typeof normalizeProjectExecutionResults<RenderedVideoResult>
>;

export function createVideoPresentationPipelineDefinition(options?: {
  runProject?: NonNullable<VideoPipelineDeps["sandbox"]>["runProject"];
}): DeliverablePipelineDefinition<VideoPresentationProjectPayload> {
  return {
    id: "video_presentation",
    jobName: VIDEO_PRESENTATION_PIPELINE_JOB_NAME,
    artifactType: "video_presentation",
    stages: videoPipelineStages,
    defaultErrorCode: VIDEO_PRESENTATION_ERROR_CODES.generationFailed,
    invalidPayloadErrorCode: VIDEO_PRESENTATION_ERROR_CODES.invalidPayload,
    billing: { feature: "video_presentation" },
    prepareJob(job) {
      return videoPresentationCreateRequestSchema.parse(job.request);
    },
    loadState(artifactPayload) {
      try {
        return videoPresentationProjectPayloadSchema.parse(artifactPayload);
      } catch (error) {
        throw new DeliverablePipelineError({
          code: VIDEO_PRESENTATION_ERROR_CODES.invalidPayload,
          message: truncateText(
            error instanceof Error
              ? error.message
              : "Invalid video presentation artifact payload",
            MAX_ERROR_MESSAGE_LENGTH,
          ),
          category: "validation",
        });
      }
    },
    prepareRun({ job, prepared, state }) {
      const request = prepared as VideoPresentationCreateRequest;
      const editPlan = resolveVideoEditPlan({
        state,
        request,
        jobArtifactId: job.artifactId,
      });
      if (!editPlan) {
        return { state, mode: "create" };
      }
      // Edit run: reset generation in-memory so no stage is checkpoint-
      // skipped and the pipeline steps restart from scratch. The published
      // payload stays untouched until markReady (host edit-mode behavior).
      return {
        mode: "edit",
        state: videoPresentationProjectPayloadSchema.parse({
          ...state,
          generation: {
            status: "running",
            stage: "planning_storyboard",
            progress: 0,
          },
        }),
      };
    },
    buildStageView(stageId, state) {
      return buildVideoPresentationStageView(
        stageId as VideoPresentationPipelineStageId,
        state,
      );
    },
    computeOverallProgress(steps) {
      return computeVideoPresentationOverallProgress(
        steps as readonly VideoPresentationPipelineStep[],
      );
    },
    finalize({ state, job }) {
      return attachReadySourceJson({
        artifactId: job.artifactId,
        jobId: job.jobId,
        payload: state,
        workspaceId: job.workspaceId,
      });
    },
    async runStage(input) {
      const { stageId, ctx, job, prepared, scratch, api } = input;
      const deps = createVideoPipelineDeps(ctx, options);
      const request = prepared as VideoPresentationCreateRequest;
      let state = input.state;
      const editPlan = resolveVideoEditPlan({
        state,
        request,
        jobArtifactId: job.artifactId,
      });
      const editTargets = editPlan
        ? new Set(editTargetSlideNumbers(editPlan, state))
        : undefined;

      switch (stageId) {
        case "planning_storyboard": {
          if (editPlan) {
            const slides = await regenerateStoryboardSlides({
              deps,
              state,
              request,
              targetSlideNumbers: [...editTargets!],
              instruction: editPlan.instruction,
            });
            state = videoPresentationProjectPayloadSchema.parse({
              ...state,
              slides,
            });
            return state;
          }
          state = await planVideoProject({
            current: state,
            deps,
            request,
          });
          return state;
        }

        case "materializing_assets": {
          const materialized = await materializeAssets({
            artifactId: job.artifactId,
            deps,
            payload: state,
            workspaceId: job.workspaceId,
          });
          state = videoPresentationProjectPayloadSchema.parse({
            ...state,
            assets: materialized.assets,
            slides: materialized.slides,
          });
          return state;
        }

        case "generating_audio_tracks": {
          const audioTracks = await generateAudioTracks({
            artifactId: job.artifactId,
            deps,
            payload: state,
            request,
            workspaceId: job.workspaceId,
            ...(editTargets ? { onlySlideNumbers: editTargets } : {}),
            onTrackReady: async ({ completed, total, tracks }) => {
              // Mid-stage progress goes through the host's step view only; the
              // partial tracks fold into the persisted payload when the stage
              // returns its final state.
              state = videoPresentationProjectPayloadSchema.parse({
                ...state,
                audioTracks: tracks,
              });
              await api.updateStageProgress({
                ...buildVideoPresentationStageView(
                  "generating_audio_tracks",
                  state,
                ),
                summary: truncatePipelineSummary(
                  `Narration ${completed}/${total}`,
                ),
                stepProgress:
                  total > 0 ? Math.round((completed / total) * 100) : 0,
                logTail: [`Generated audio track ${completed}/${total}`],
              });
            },
          });
          state = videoPresentationProjectPayloadSchema.parse({
            ...state,
            audioTracks,
          });
          return state;
        }

        case "assigning_slide_themes": {
          // Edit runs keep existing themes for visual continuity; only run
          // the assignment LLM when some slide has no theme yet.
          if (editPlan) {
            const assigned = new Set(
              state.themeAssignments.map(
                (assignment) => assignment.slideNumber,
              ),
            );
            const allAssigned = state.slides.every((slide) =>
              assigned.has(slide.slideNumber),
            );
            if (allAssigned) {
              return state;
            }
          }
          const themeAssignments = await assignSlideThemes({
            deps,
            payload: state,
          });
          state = videoPresentationProjectPayloadSchema.parse({
            ...state,
            themeAssignments,
          });
          return state;
        }

        case "generating_scene_modules": {
          const sceneModules = await generateSceneModules({
            deps,
            payload: state,
            ...(editTargets ? { onlySlideNumbers: editTargets } : {}),
          });
          state = videoPresentationProjectPayloadSchema.parse({
            ...state,
            sceneModules,
          });
          return state;
        }

        case "repairing_scene_modules": {
          const repairedSceneModules = await repairSceneModules({
            deps,
            payload: state,
          });
          const failedScenes = repairedSceneModules.filter(
            (scene) =>
              scene.compileStatus === "failed" || scene.diagnostics.length > 0,
          );
          if (failedScenes.length > 0) {
            const first = failedScenes[0]!;
            throw new Error(
              `Scene ${first.slideNumber} failed validation after repair: ${first.diagnostics.join("; ")}`,
            );
          }
          state = videoPresentationProjectPayloadSchema.parse({
            ...state,
            sceneModules: repairedSceneModules,
          });
          return state;
        }

        case "installing_project": {
          // The sandbox installs the generated Remotion project, typechecks it,
          // and smoke-renders slide stills for visual QA. It intentionally does
          // NOT render a full mp4 (`renderVideo` is omitted): every surface —
          // the owner's in-app preview AND the public share — plays the deck by
          // client-compiling the Remotion project in the browser, so a
          // server-side mp4 render only added generation latency (and a heavy
          // sandbox render) for a file nothing consumes. Narration therefore no
          // longer needs staging into the sandbox either.
          const run = normalizeProjectExecutionResults(
            await runGeneratedProject({
              deps,
              job,
              payload: state,
              request,
            }),
          );
          scratch.projectRun = run;
          // Degradations become stage-visible instead of log-only: the exact
          // silent chain of the cover-image incident (asset ladder → stills →
          // QA → cover), surfaced where the user already watches progress.
          {
            const logTail: string[] = [];
            for (const resolution of run.assetResolutions ?? []) {
              if (resolution.ok && resolution.rung !== "image") {
                logTail.push(
                  `render browser staged via ${resolution.rung} (${resolution.ms}ms) — image bake missing in this sandbox`,
                );
              } else if (!resolution.ok) {
                logTail.push(
                  `⚠ ${resolution.name} unavailable (${truncateText(resolution.error ?? "no rung succeeded", 160)}) — renderer falls back to runtime download`,
                );
              }
            }
            if (logTail.length > 0) {
              await api.updateStageProgress({ logTail });
            }
          }
          state = videoPresentationProjectPayloadSchema.parse({
            ...state,
            projectCode: {
              install: run.install,
              typecheck: {
                ok: false,
                diagnostics: [],
              },
              smoke: {
                checked: false,
                ok: false,
                diagnostics: [],
              },
            },
          });
          if (!run.install.ok) {
            throw new Error(
              `Generated Remotion project dependency install failed: ${run.install.diagnostics.join("; ") || run.install.stderr || "unknown install failure"}`,
            );
          }
          return state;
        }

        case "typechecking_project": {
          const projectRun = scratch.projectRun as
            | ProjectRunResults
            | undefined;
          if (!projectRun) {
            throw new Error(
              "Generated Remotion project run did not produce results",
            );
          }
          state = videoPresentationProjectPayloadSchema.parse({
            ...state,
            projectCode: {
              ...state.projectCode,
              install: projectRun.install,
              typecheck: projectRun.typecheck,
              smoke: {
                checked: false,
                ok: false,
                diagnostics: [],
              },
            },
          });
          if (!projectRun.typecheck.ok) {
            throw new Error(
              `Generated Remotion project failed typecheck: ${projectRun.typecheck.diagnostics.join("; ") || projectRun.typecheck.stderr || "unknown typecheck failure"}`,
            );
          }
          return state;
        }

        case "rendering_smoke_preview": {
          const projectRun = scratch.projectRun as
            | ProjectRunResults
            | undefined;
          if (!projectRun) {
            throw new Error(
              "Generated Remotion project run did not produce results",
            );
          }
          state = videoPresentationProjectPayloadSchema.parse({
            ...state,
            projectCode: {
              install: projectRun.install,
              typecheck: projectRun.typecheck,
              smoke: {
                checked: true,
                ...projectRun.smoke,
              },
            },
          });
          if (!projectRun.smoke.ok) {
            throw new Error(
              `Generated Remotion project failed render smoke check: ${projectRun.smoke.diagnostics.join("; ") || projectRun.smoke.stderr || "unknown smoke failure"}`,
            );
          }
          return state;
        }

        case "verifying_visual_quality": {
          const projectRun = scratch.projectRun as
            | ProjectRunResults
            | undefined;
          if (!projectRun) {
            throw new Error(
              "Generated Remotion project run did not produce results",
            );
          }
          try {
            const visualQa = await runVisualQualityCheck({
              deps,
              payload: state,
              stills: projectRun.stills ?? [],
              ...(editTargets ? { onlySlideNumbers: editTargets } : {}),
            });
            if (!visualQa) {
              deps.logger.info("video_presentation_visual_qa_skipped", {
                artifactId: job.artifactId,
                jobId: job.jobId,
                stillCount: projectRun.stills?.length ?? 0,
              });
              await api.updateStageProgress({
                logTail: [
                  (projectRun.stills?.length ?? 0) === 0
                    ? `⚠ visual QA skipped — no slide stills (${truncateText(projectRun.stillsUnavailableReason ?? "renderer produced none", 160)})`
                    : "⚠ visual QA skipped — no vision profile configured",
                ],
              });
              return state;
            }
            const withRepairedScenes = {
              ...state,
              sceneModules: visualQa.sceneModules,
            };
            state = videoPresentationProjectPayloadSchema.parse({
              ...withRepairedScenes,
              projectCode: {
                ...state.projectCode,
                install: projectRun.install,
                typecheck: projectRun.typecheck,
                smoke: { checked: true, ...projectRun.smoke },
              },
            });
          } catch (error) {
            // Visual QA is a quality gate, not an availability gate: any
            // failure (vision profile missing, judge error) degrades to skip.
            deps.logger.warn("video_presentation_visual_qa_failed", {
              artifactId: job.artifactId,
              jobId: job.jobId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return state;
        }

        case "publishing_video_project": {
          const durationInFrames = state.sceneModules.reduce(
            (sum, scene) => sum + scene.durationInFrames,
            0,
          );
          const durationSeconds = Number(
            (durationInFrames / state.project.fps).toFixed(2),
          );

          // Store a cover still as the artifact thumbnail. Best-effort end to
          // end: a resumed run with no stills in scratch, or a sandbox that
          // never rendered any, simply leaves the existing thumbnail alone.
          const projectRun = scratch.projectRun as
            | ProjectRunResults
            | undefined;
          if (!projectRun?.stills?.length) {
            await api.updateStageProgress({
              logTail: [
                `⚠ cover image skipped — no slide stills (${truncateText(projectRun?.stillsUnavailableReason ?? "not rendered in this run", 160)})`,
              ],
            });
          }
          if (projectRun?.videoUnavailableReason) {
            await api.updateStageProgress({
              logTail: [
                `⚠ server mp4 skipped (${truncateText(projectRun.videoUnavailableReason, 120)}) — browser preview remains available`,
              ],
            });
          }
          if (projectRun?.stills?.length) {
            try {
              const coverImage = await uploadCoverImage({
                artifactId: job.artifactId,
                deps,
                payload: state,
                stills: projectRun.stills,
                workspaceId: job.workspaceId,
              });
              if (coverImage) {
                api.setPreviewImage(coverImage);
              }
            } catch (error) {
              deps.logger.warn("video_presentation_cover_image_failed", {
                artifactId: job.artifactId,
                jobId: job.jobId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          state = videoPresentationProjectPayloadSchema.parse({
            ...state,
            project: {
              ...state.project,
              durationSeconds,
            },
            preview: {
              ...state.preview,
              slideCount: state.slides.length,
              durationSeconds,
            },
            // No server-side mp4 is rendered any more (see installing_project);
            // every surface client-compiles the Remotion project, so the deck
            // always publishes as a browser-rendered presentation.
            renderedVideo: undefined,
          });
          return state;
        }

        default:
          throw new Error(
            `Unknown video presentation pipeline stage: ${stageId}`,
          );
      }
    },
  };
}

export const createDeliverablePipelines: CreateDeliverablePipelines = () => [
  createVideoPresentationPipelineDefinition(),
];
