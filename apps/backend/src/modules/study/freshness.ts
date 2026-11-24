import {
  compareInputFreshness,
  loadInputFreshness,
  type InputFreshness,
} from "../grounded-generation/freshness";

export type StudyFreshness = InputFreshness;

export const compareStudyFreshness = compareInputFreshness;
export const loadStudyFreshness = loadInputFreshness;
