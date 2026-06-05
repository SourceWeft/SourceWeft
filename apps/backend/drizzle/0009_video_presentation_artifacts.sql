ALTER TABLE artifacts
  DROP CONSTRAINT IF EXISTS artifacts_artifact_type_check;

ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_artifact_type_check
  CHECK (
    artifact_type IN (
      'report',
      'slides',
      'mindmap',
      'podcast',
      'audio_overview',
      'video_overview',
      'video_presentation',
      'flashcards',
      'quiz',
      'table',
      'infographic',
      'image'
    )
  );
