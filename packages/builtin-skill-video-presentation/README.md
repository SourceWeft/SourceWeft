# Video Presentation Skill

The Video Presentation skill runs in the existing root Agent turn. The Agent
authors a canonical draft in the active sandbox and chooses among five
root-only typed tools:

- `load_video_presentation`
- `generate_video_assets`
- `generate_video_narration`
- `validate_video_presentation`
- `publish_video_presentation`

Validation binds the exact draft/resources, three runtime samples per scene,
visual review, required cover, and trusted sandbox-rendered MP4 to a protected
receipt. Publication atomically commits that media, the artifact version,
canonical tool result, and chat card under the active run fence. Browser clients
only play or download the committed MP4; they never execute authored scene code.
