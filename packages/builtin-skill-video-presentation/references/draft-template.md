# Draft Template

Use this as the structural starting point, then replace every placeholder with
the current request. Keep the JSON valid; scene `code` is a JSON string.

```json
{
  "schemaVersion": 1,
  "kind": "video_presentation_draft",
  "workflowVersion": "video-presentation-agent",
  "builderVersion": "remotion-project",
  "narrationPolicy": { "enabled": false },
  "renderProfile": {
    "stylePreset": "technical",
    "visualDensity": "balanced",
    "durationTarget": "medium",
    "language": "en"
  },
  "sourceDigest": "Concise semantic source summary and must-include facts",
  "project": {
    "title": "Project title",
    "fps": 30,
    "width": 1920,
    "height": 1080,
    "durationSeconds": 10,
    "stylePreset": "technical",
    "globalVisualDirection": "Specific visual system, palette, composition, and motion"
  },
  "slides": [
    {
      "slideNumber": 1,
      "title": "One clear idea",
      "speakerTranscript": ["A complete narration sentence."],
      "sceneIntent": "What changes on screen and why",
      "assetRefs": [],
      "assetNeeds": []
    }
  ],
  "sceneModules": [
    {
      "slideNumber": 1,
      "title": "One clear idea",
      "code": "export default function VideoScene(){ const frame = useCurrentFrame(); return <AbsoluteFill style={{backgroundColor: '#070b18'}}><SafeArea><TitleBlock title=\"One clear idea\" subtitle=\"Trusted sandbox scene\" style={{color: 'white', opacity: interpolate(frame, [0, 20], [0, 1], {extrapolateRight: 'clamp'})}} /></SafeArea></AbsoluteFill>; }",
      "componentName": "VideoScene",
      "durationInFrames": 300,
      "diagnostics": [],
      "layoutWarnings": [],
      "compileStatus": "compiled"
    }
  ],
  "audioTracks": [],
  "assets": [],
  "themeAssignments": []
}
```

For narration-enabled projects, call `generate_video_narration`, then add
exactly one returned track per slide:

```json
{
  "slideNumber": 1,
  "durationSeconds": 4.2,
  "mimeType": "audio/mpeg",
  "fileName": "slide-1.mp3",
  "resource": {
    "kind": "local",
    "sandboxPath": "/workspace/.../public/audio/slide-1.mp3",
    "blobRef": "<returned opaque ref>",
    "contentDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "contentType": "audio/mpeg"
  }
}
```

Replace the example digest with the exact returned 64-hex SHA-256 value.

The draft never contains the final MP4, cover, public URLs, or storage
coordinates. `validate_video_presentation` renders and binds the MP4 and cover
before returning its protected receipt; `publish_video_presentation` is the
only operation that commits them as an artifact version.

Generated assets use the same local resource shape and the metadata returned by
`generate_video_assets`. Loaded edits already contain `kind:"committed"`
resource handles; keep them unchanged unless replacing that resource.

Reference either kind of asset in scene code only as
`sourceweft-asset:<assetId>`. Example: an asset whose `assetId` is
`black-hole-photo` is passed to `AssetImage` as
`src="sourceweft-asset:black-hole-photo"`. Do not use the returned sandbox path,
`/assets/...`, storage keys, or provider URLs in authored scene code.

Scene code may use the runtime layout primitives (`SafeArea`, `TitleBlock`,
`BulletList`, `SplitLayout`, `StatHero`, `AssetImage`, `QuoteBlock`) and Remotion
APIs. Keep all readable foreground content inside `SafeArea`; use full-bleed
elements only for backgrounds/decorations.
