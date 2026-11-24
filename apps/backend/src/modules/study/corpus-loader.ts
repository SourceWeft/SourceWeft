import {
  checkGroundedSources,
  loadGroundedCorpus,
  type GroundedCorpus,
  type GroundedSourceSnapshot,
} from "../grounded-generation/corpus-loader";

/** What a version was generated from, kept for staleness and attribution. */
export type StudySourceSnapshot = GroundedSourceSnapshot;
export type StudyCorpus = GroundedCorpus;

export const checkStudySources = checkGroundedSources;
export const loadStudyCorpus = loadGroundedCorpus;
