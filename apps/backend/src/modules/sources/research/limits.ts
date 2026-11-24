export const RESEARCH_LIMITS = {
  maxRounds: 4,
  maxSearches: 20,
  maxPages: 30,
  maxMillis: 600_000,
  maxModelCalls: 24,
  perUserConcurrent: 1,
  perTeamConcurrent: 3,
  perUserPerDay: 20,
} as const;
