/**
 * Every user-facing string the skill market added to the dashboard: the
 * gallery's filters and sections, the card and detail facts, the market admin
 * panel and the admin review tab. `main` has no i18n library yet — when it
 * lands, this one file is what gets swapped for message lookups.
 */
export const skillsMarketCopy = {
  gallery: {
    filtersTitle: "Filters",
    clearAll: "Clear all",
    searchLabel: "Search",
    searchPlaceholder: "Search skills",
    searchSummaryAll: "all",
    categoryLabel: "Category",
    categoryAll: "All",
    trustLabel: "Publisher",
    capabilityLabel: "Capability",
    installedLabel: "Status",
    sortBy: "Sort by",
    sectionBuiltin: "Built-in",
    sectionYours: "Your skills",
    sectionCommunity: "Community",
    // Community skills matching the filters in all, not just the loaded pages.
    communityTotal: (count: number) =>
      `${count.toLocaleString("en")} community skill${count === 1 ? "" : "s"}`,
    loadMore: "Load more",
    loadingMore: "Loading more skills…",
    loadMoreFailed: "Failed to load more skills.",
    loadFailedTitle: "Skills could not be loaded",
    loadFailed: "Failed to load skills.",
    emptyCatalog: "No skills are available for this workspace.",
    emptyFiltered: "No skills match the current filters.",
  },
  trustOptions: {
    all: "All publishers",
    builtin: "Official",
    verified: "Verified",
    community: "Community",
  },
  capabilityOptions: {
    all: "Any capability",
    "prompt-only": "Instructions only",
    executable: "Includes scripts",
  },
  installedOptions: {
    all: "All",
    installed: "Installed",
    not_installed: "Not installed",
  },
  sortOptions: {
    recommended: "Recommended",
    popular: "Most added",
    stars: "Most starred",
    new: "Newest",
    name: "Name A-Z",
  },
  // "Installs" are workspaces that added the skill. Local installs with the
  // CLI send nothing back, so the number never includes them.
  card: {
    verified: "Verified",
    includesScripts: "Includes scripts",
    installs: (formatted: string) => `Added to ${formatted} workspaces`,
    installsOne: "Added to 1 workspace",
  },
  detail: {
    categories: "Categories",
    installs: "Workspaces",
    restrictedNotice:
      "This skill is not publicly listed, so its full instructions are only shown to workspaces that installed it. Install to read them",
    restrictedSourceJoin: " — or ",
    restrictedSourceLink: "view the source",
  },
  // An install pins one version. These say the skill has moved on, and ask
  // before an `?install=1` link from the public market installs anything.
  updates: {
    hubBadge: "Update available",
    hubBadgeTitle: "A newer version is available — open the skill to update",
    notice: "A newer version is available.",
    noticeWithVersion: (version: string) =>
      `A newer version is available: ${version}.`,
    action: "Update to the newest version",
    // What the newer version changed from the one before it.
    changesLead: "What changed:",
    changedFiles: (count: number) =>
      `${count} file${count === 1 ? "" : "s"}`,
    noFileChanges: "no file changes",
    newScripts: (count: number) =>
      `${count} new script${count === 1 ? "" : "s"}`,
    newFlags: (count: number) =>
      `${count} new scan flag${count === 1 ? "" : "s"}`,
    compare: "Compare on GitHub",
    installPrompt: (name: string) => `Install ${name} to this workspace?`,
    installPromptLabel: "Confirm install",
    installConfirm: "Install",
    installCancel: "Cancel",
  },
  adminPanel: {
    title: "Market admin",
    standing: "Standing",
    standingPublic: "Public",
    standingRestricted: "Restricted",
    standingWithdrawn: "Withdrawn (held)",
    standingOwnerPrivate: "Kept private by its owner",
    listed: "Listed",
    notListed: "Not listed",
    installs: "Workspaces",
    verified: "Verified",
    verifiedHint: "Vouch for this skill on the market.",
    categories: "Categories",
    categoriesHint: "Pick 1 to 5.",
    saveCategories: "Save categories",
    listPublicly: "List publicly",
    withdraw: "Withdraw",
    confirmListTitle: "List this skill publicly?",
    confirmListBody:
      "Anyone will be able to find this skill and read its full instructions on the market.",
    confirmWithdrawTitle: "Withdraw this skill from the market?",
    confirmWithdrawBody:
      "It leaves the public market and is held back from automatic listing. Workspaces that already installed it keep using it.",
    cancel: "Cancel",
    actionFailed: "Market action failed.",
    categoryInvalid: "One of the selected categories no longer exists.",
    listedToast: "Skill listed publicly",
    withdrawnToast: "Skill withdrawn from the market",
    verifiedToast: "Skill marked verified",
    unverifiedToast: "Verified mark removed",
    categoriesToast: "Categories updated",
  },
  review: {
    pageEyebrow: "Market · Admin",
    tabMcp: "MCP",
    tabSkills: "Skills",
    title: "Review skill submissions",
    intro:
      "Skills that pass the automated scan are published automatically. This queue contains flagged versions that need manual review.",
    forbidden: "You do not have permission to review skill submissions.",
    loadFailed: "Failed to load the skill review queue. Please try again.",
    loading: "Loading review queue…",
    empty: "No skill submissions need review.",
    actionFailed: (slug: string) => `Action failed: ${slug}`,
    submittedBy: (who: string) => `Submitted by ${who}`,
    noLicense: "No license",
    capabilityPromptOnly: "Instructions only",
    capabilityExecutable: "Includes scripts",
    readSkillMd: "Read SKILL.md",
    hideSkillMd: "Hide SKILL.md",
    loadingSkillMd: "Loading SKILL.md…",
    skillMdFailed: "Failed to load SKILL.md.",
    skillMdMissing: "This version has no SKILL.md text.",
    reasonLabel: "Reason (optional)",
    reasonPlaceholder: "Recorded with the decision",
    publish: "Approve and publish",
    reject: "Reject",
    footnote: "Skill review uses the same admin allowlist as the MCP market.",
  },
  // The owner's switch on a community skill they imported.
  ownerListing: {
    label: "Allow on the public market",
    listed:
      "This skill is listed publicly: anyone can find it and read its SKILL.md. Turn this off to take it down — workspaces that installed it keep it.",
    pending:
      "Skills that pass the automated scan are listed publicly a few minutes after import; flagged ones wait for a review first. Turn this off to keep it to yourself.",
    private:
      "Only you and the workspaces you add it to can see this skill. It will not be listed.",
    heldByAdmin:
      "A market admin took this skill off the public market. Only they can list it again.",
    allowedToast: "This skill may be listed publicly",
    privateToast: "This skill is kept private",
    failed: "Could not change the listing. Please try again.",
  },
  // The second admin queue: published skills that carry an advisory flag. Their
  // importer can already use them; going public is the admin's decision.
  listingQueue: {
    title: "Decide what goes public",
    intro:
      "A skill with a clean scan lists itself. These are published and usable by whoever imported them, but carry an advisory flag — so showing them to everyone is your call. Public skills whose new version adds scan flags or scripts are here too: they stay public until you keep or withdraw them.",
    forbidden: "You do not have permission to manage skill listings.",
    loadFailed: "Failed to load the listing queue. Please try again.",
    loading: "Loading listing queue…",
    empty: "No skills are waiting for a listing decision.",
    publish: "List publicly",
    reject: "Keep private",
    footnote:
      "Keeping a skill private holds it: it will not list itself later. You can list it from its own page at any time.",
    // A public skill whose new version brought flags or scripts. It stays
    // public until the admin decides.
    reasons: {
      flagged: "Flagged, not public yet",
      "new-version-flags": "Public · new version adds scan flags",
      "new-version-scripts": "Public · new version adds scripts",
    } as Record<string, string>,
    keepPublic: "Keep public",
    withdraw: "Withdraw",
    changesTitle: "Changes from the previous version",
    changesAdded: (paths: string) => `Added: ${paths}`,
    changesRemoved: (paths: string) => `Removed: ${paths}`,
    changesModified: (paths: string) => `Modified: ${paths}`,
    changesNewScripts: (paths: string) => `New scripts: ${paths}`,
    changesNewFlags: (flags: string) => `New scan flags: ${flags}`,
    compare: "Compare on GitHub",
  },
  // Editorial collections on the public directory, managed by market admins.
  collections: {
    tab: "Collections",
    title: "Collections",
    intro:
      "Hand-picked sets of public skills, shown on the public skills directory. Only published collections appear there, and inside one only the skills that are public.",
    loading: "Loading collections…",
    loadFailed: "Failed to load collections. Please try again.",
    forbidden: "You do not have permission to manage collections.",
    empty: "No collections yet.",
    newTitle: "New collection",
    slugLabel: "Slug",
    slugPlaceholder: "office-work",
    slugHint: "Lowercase letters, digits and dashes. It is the page address and cannot change.",
    titleLabel: "Title",
    summaryLabel: "Summary",
    positionLabel: "Position",
    publishedLabel: "Published",
    create: "Create",
    save: "Save",
    delete: "Delete",
    confirmDelete: (title: string) => `Delete the collection “${title}”?`,
    skillsLabel: "Skills, one slug per line, in order",
    saveSkills: "Save skills",
    notPublic: "not public",
    view: "View",
    saved: "Saved",
    failed: "The change was not saved.",
    skillCount: (count: number) =>
      `${count} skill${count === 1 ? "" : "s"}`,
  },
  flagLabels: {
    "egress:pipe-to-shell": "Fetch and run: curl | sh",
    "egress:base64-exec": "base64 | sh",
    "egress:external-post": "Posts data to an external host",
    "egress:fetch": "Outbound network call",
    "injection:override": "Prompt injection: overrides instructions",
    "injection:system-prompt": "Mentions the system prompt",
    "secrets:read-credentials": "Reads credential files",
    "secrets:env-access": "Reads environment variables",
    "scope:other-skill-file": "Reads another skill's files",
    "tool:sensitive": "Requests code-execution tools",
    "binary:executable": "Ships an executable binary",
    "sticky-review": "Held for review: an earlier version is unresolved",
  } as Record<string, string>,
} as const;
