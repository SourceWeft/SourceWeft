/**
 * English strings for the AI overview (§17.4): the overview block, the market
 * admin's per-skill controls and the market settings tab. Kept on their own
 * so they can be moved into the app's messages in one step.
 */
export const skillOverviewCopy = {
  block: {
    title: "AI-generated overview",
    explainer:
      "Written by an AI model from this skill's SKILL.md and file list. It can be wrong or incomplete — check the skill's own documentation before relying on it.",
    explainerLabel: "About this overview",
    whatItDoes: "What it does",
    whenToUse: "When to use it",
    requirements: "Requirements",
    englishFallback: "Shown in English: no overview in your language yet.",
  },
  admin: {
    title: "AI overview",
    loading: "Loading overview…",
    none: "No overview for the current version yet.",
    notEligible:
      "Not generated for this skill: only public skills imported from GitHub get one.",
    noVersion: "This skill has no current published version.",
    hidden: "Hidden",
    visible: "Shown",
    missing: "Missing",
    model: "Model",
    generatedAt: "Generated",
    regenerate: "Regenerate",
    regenerateQueued: "Queued. The new overview appears within a few minutes.",
    regenerateNotQueued:
      "Removed. This skill is not one overviews are written for, so none was queued.",
    hide: "Hide",
    show: "Show",
    hiddenDone: "Overview hidden.",
    shownDone: "Overview shown.",
    failed: "Something went wrong. Try again.",
  },
  settings: {
    title: "AI overviews",
    description:
      "Overviews are written by the default chat model and billed to the team, workspace and member chosen here. Nothing is generated until this is set.",
    current: "Billed to",
    notSet: "Not set — no overviews are being generated.",
    team: "Team",
    workspace: "Workspace",
    member: "Billed member (user id)",
    memberHint:
      "Leave empty to bill yourself. Must be a member of the workspace.",
    choose: "Choose…",
    save: "Save",
    saving: "Saving…",
    saved: "Saved.",
    failed: "Could not save.",
    loadFailed: "Could not load the overview settings.",
    updatedBy: "Last changed by",
    status: "Coverage",
    eligible: "Eligible skills",
    withOverview: "With an overview",
    missingCount: "Missing",
    hiddenCount: "Hidden",
    billingSet: "Billing set",
    yes: "Yes",
    no: "No",
  },
} as const;
