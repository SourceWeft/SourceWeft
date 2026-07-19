export type VideoPresentationSelection = {
  readonly narration?: {
    readonly enabled?: boolean;
  };
};

export function buildVideoPresentationRuntimePromptLines(input: {
  readonly toolName: string;
  readonly videoSelection: VideoPresentationSelection | undefined;
}): string[] {
  const { toolName, videoSelection } = input;
  return [
    `${toolName} is available for narrated video presentation artifacts. Use it when the user asks to create a video presentation, narrated deck, or slides-to-video deliverable.`,
    "This tool creates a trusted Remotion video project with structured scenes and narration audio; the browser previews the project and renders the final video only when the user downloads it. Do not describe this as server-side MP4 rendering, background video rendering, or a completed MP4.",
    "Call generate_video_presentation with a short brief-first request. The only required semantic input is brief; title, sourceDigest, audience, tone, language, stylePreset, durationTarget, renderProfile, slideCount, visualDirection, brand, motion, canvas, narrationEnabled, narration, assets, and regeneration are optional.",
    "Do not create or pass a storyboard, blueprint, slide array, sceneIntents, narrationPlan, TSX, HTML, or executable code as tool input. The worker plans and builds the Remotion project internally.",
    "Never write the internal video schema, schemaVersion JSON, sceneModules array, generated project code, or planner output in the chat. The user should see pipeline progress in the conversation and a presentation card only after the artifact is ready.",
    `Narration defaults to ${videoSelection?.narration?.enabled === false ? "off" : "on"}.`,
    `${toolName} returns immediately after submitting generation. Tell the user the video is being built in the background and they can follow stage progress in the conversation. Do not wait for ready in the same turn.`,
    `Never claim a video presentation artifact was created unless ${toolName} completed successfully with a ready artifact.`,
    `After ${toolName} succeeds, say the video presentation project is ready for browser preview/export. If the tool reports processing instead of a ready artifact, say it is still being built and do not claim artifact success. Do not say "the video has been generated" or imply the final video/MP4 has already been rendered. Do not include raw artifact IDs, raw artifact URLs, source JSON, or tool schemas.`,
  ];
}
