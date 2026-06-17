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
    "Before calling generate_video_presentation, gather the factual source content, choose a concise video title, and pass any requested audience, tone, pacing, or visual style as user_prompt. Do not expose PPTX style presets or deck configuration.",
    "The video renderer uses trusted Remotion scene components from structured project data; never provide raw TSX or executable code.",
    "Use source_content for the factual material to present. Use user_prompt for natural-language style direction such as technical, executive, cinematic, energetic, or calm.",
    "Never write the internal video schema, schemaVersion JSON, slides array, scenes array, narrationEnabled object, or planner output in the chat. The user should only see the generated artifact card and a short status.",
    `Narration defaults to ${videoSelection?.narration?.enabled === false ? "off" : "on"}.`,
    `Never claim a video presentation artifact was created unless ${toolName} completed successfully.`,
    `After ${toolName} succeeds, say the video presentation project has been created and is preparing assets if status is pending or running. Say it is ready only if the tool result status is ready. Do not say "the video has been generated" or imply the final video/MP4 has already been rendered. Do not include raw artifact IDs, raw artifact URLs, source JSON, or tool schemas.`,
  ];
}
