export {
  DICTATION_PROFILE_ALIAS,
  isDictationAvailable,
  transcribeDictationSegment,
} from "./service";
export type {
  DictationDeps,
  DictationProfile,
  DictationSegmentResult,
} from "./service";
export {
  createDictationSlots,
  dictationRateRules,
  dictationSlots,
} from "./limits";
export type { DictationSlots } from "./limits";
