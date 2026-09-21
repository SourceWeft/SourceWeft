// Every user-facing string of the public /skills pages lives here, so the i18n
// branch can swap this one file for message catalogs when it lands.

export const SUPPORT_EMAIL = "support@sourceweft.com";

export const skillsCopy = {
  brand: "SourceWeft Skills",
  landing: {
    title: "Agent Skills Directory",
    description:
      "Browse public agent skills for SourceWeft. Read each skill's full SKILL.md, files, versions, license, and source repository before adding it to a workspace.",
    socialDescription:
      "A public directory of agent skills with their full SKILL.md, files, versions, license, and source.",
    heroWithCount: (count: string) => `Explore ${count} agent skills`,
    heroWithoutCount: "Explore agent skills",
    heroTail:
      "with the full instructions, files, license, and source up front, then add them to a SourceWeft workspace.",
    searchLabel: "Search skills",
    searchPlaceholder: "Search by name, author, or what the skill does",
    searchSubmit: "Search",
    sections: {
      recommended: {
        title: "Recommended",
        description:
          "Skills from featured publishers and verified skills first, then the ones workspaces add most and whose repositories are most starred.",
      },
      newest: {
        title: "Newest",
        description: "Skills most recently listed in the directory.",
      },
      popular: {
        title: "Most added",
        description: "The skills SourceWeft workspaces add most often.",
      },
      collections: {
        title: "Collections",
        description: "Hand-picked sets of skills for common jobs.",
      },
    },
    viewAll: "View all",
    browseByCategory: "Browse by category",
    emptyTitle: "Skills are syncing.",
    emptyBody:
      "The public directory is available, but no skills are listed yet.",
    getStarted: {
      install: {
        title: "Install",
        description: "Add any listed skill to a SourceWeft workspace.",
        steps: [
          "Pick a skill and read its SKILL.md, files, and license.",
          "Add it to a workspace from the Skills page in your dashboard.",
          "Use it in chat — or paste the skill's page link and ask the assistant to install it.",
        ],
        ctaSignedIn: "Open Skills in dashboard",
        ctaSignedOut: "Sign in to install",
      },
      publish: {
        title: "Publish",
        description: "List a skill from your own public repository.",
        steps: [
          "Keep the skill in a public GitHub repository with a SKILL.md.",
          "Import the repository from the Skills page in the dashboard.",
          "Skills that pass the automated scan are listed; flagged ones wait for review.",
        ],
        ctaSignedIn: "Import a skill",
        ctaSignedOut: "Sign in to import",
      },
    },
  },
  listing: {
    allSkills: "All skills",
    allSkillsTitle: "All skills",
    resultsFor: (query: string) => `Results for “${query}”`,
    resultsForIn: (query: string, category: string) =>
      `Results for “${query}” in ${category}`,
    categories: "Categories",
    marketHome: "Directory home",
    sortLabel: "Sort",
    clearFilters: "Clear filters",
    exactCount: (count: number) =>
      `${count.toLocaleString("en")} skill${count === 1 ? "" : "s"}`,
    pageCount: (count: number) =>
      `${count.toLocaleString("en")} skill${count === 1 ? "" : "s"} on this page`,
    noMatchTitle: "No skills match these filters.",
    noMatchBody: "Try a broader search or another category.",
    firstPage: "First page",
    nextPage: "Next page",
    pagination: "Pagination",
  },
  sortOptions: {
    recommended: "Recommended",
    popular: "Most added",
    stars: "Most starred",
    new: "Newest",
    name: "Name",
  },
  trustOptions: {
    all: "Any trust",
    featured: "Featured",
    verified: "Verified",
  },
  capabilityOptions: {
    all: "Any type",
    "prompt-only": "Instructions only",
    executable: "Includes scripts",
  },
  category: {
    title: (name: string) => `${name} Skills`,
    fallbackMetaTitle: "Skill Category",
    metaDescription: (name: string) =>
      `Browse public ${name} agent skills with their full SKILL.md, files, versions, license, and source.`,
    description: (name: string) =>
      `Public ${name} agent skills you can add to a SourceWeft workspace.`,
    back: "Back to skills directory",
  },
  breadcrumb: {
    label: "Breadcrumb",
    home: "Home",
    skills: "Skills",
  },
  badges: {
    verified: "Verified",
    featured: "Featured",
    featuredTitle:
      "From a featured publisher: a major vendor's own skills repository",
    executable: "Includes scripts",
    promptOnly: "Instructions only",
    claimed: "Claimed by author",
    claimedTitle: "The repository's author claimed it on SourceWeft",
    archived: "Archived",
    archivedTitle:
      "The source repository is archived on GitHub: it no longer receives updates",
  },
  card: {
    // Workspace adds only: installing with the CLI sends nothing back.
    workspaces: (count: string) =>
      count === "1"
        ? "Added to 1 workspace"
        : `Added to ${count} workspaces`,
    stars: (count: string) => `${count} GitHub stars`,
    updated: (relative: string) => `updated ${relative}`,
    unknownAuthor: "Unknown author",
  },
  collections: {
    itemCount: (count: number) =>
      `${count.toLocaleString("en")} skill${count === 1 ? "" : "s"}`,
    fallbackMetaTitle: "Skill Collection",
    metaTitle: (title: string) => `${title} — Agent Skills`,
    metaDescription: (title: string, summary: string) =>
      summary
        ? `${title}: ${summary}`
        : `${title}: a hand-picked collection of agent skills.`,
    eyebrow: "Collection",
    back: "Back to skills directory",
    empty: "No skills in this collection are public right now.",
  },
  detail: {
    fallbackMetaTitle: "Agent Skill",
    metaTitle: (name: string) => `${name} Agent Skill`,
    metaDescription: (name: string, description: string) =>
      `${name}: ${description} Read the full SKILL.md, files, versions, license, and source.`,
    noLicense: "No license",
    by: "by",
    repository: "Repository",
    source: "Source",
    listed: (date: string) => `Listed ${date}`,
    updated: (date: string) => `Updated ${date}`,
    workspaces: (count: string) =>
      count === "1"
        ? "Added to 1 workspace"
        : `Added to ${count} workspaces`,
    stars: (count: string) => `${count} stars`,
    repoPushed: (relative: string) => `Repository updated ${relative}`,
    claimLink: "Are you the author? Claim this repository",
    facts: {
      version: "Version",
      license: "License",
      workspaces: "Workspaces",
      stars: "GitHub stars",
      files: "Files",
    },
    tabs: {
      skill: "SKILL.md",
      files: (count: number) => `Files (${count})`,
      versions: (count: number) => `Versions (${count})`,
      install: "Install",
    },
    tabsLabel: "Skill sections",
    skillMdMissing: "This skill's SKILL.md has no body text to show.",
    imagePlaceholder: "Image",
    files: {
      path: "Path",
      size: "Size",
      type: "Type",
      unknownType: "—",
      note: "Only the file list is public. File contents are available once the skill is installed in a workspace.",
      empty: "No files are listed for this version.",
    },
    versions: {
      current: "Current",
      published: (date: string) => `Published ${date}`,
      unpublishedDate: "Date unknown",
      commit: "commit",
      empty: "No published versions yet.",
      noChanges: "No file changes",
      compare: "Compare on GitHub",
      newScripts: (paths: string) => `New scripts: ${paths}`,
      newFlags: (flags: string) => `New scan flags: ${flags}`,
    },
    install: {
      heading: "Add to a SourceWeft workspace",
      cta: "Add to SourceWeft",
      steps: [
        "Open the skill in your dashboard and add it to a workspace.",
        "Enable it for the chats that should use it.",
      ],
      signedOutNote:
        "You will be asked to sign in first, then taken straight to this skill.",
      chatLead: "or just ask in chat:",
      // The full slug, and the word "skill": a short name like `pdf` exists in
      // many repositories (the assistant would have to ask which), and a bare
      // "install pdf" reads like a package to install in a sandbox.
      chatPrompt: (slug: string) => `Install the skill ${slug}`,
      copy: "Copy",
      executableNote:
        "This skill includes scripts. They run in your workspace sandbox when the skill is used — review the file list and source before adding it.",
      promptOnlyNote:
        "This skill is instructions only: it ships no scripts to execute.",
      cli: {
        heading: "Install on your own machine — recommended",
        lead: "For Claude Code, Codex, Cursor and other local agents. The SourceWeft CLI fetches the skill from its source repository at the commit scanned here, and verifies every file against the hashes recorded when the skill was scanned. If anything differs, nothing is written.",
        agentHint:
          "Add --agent claude-code, codex, cursor or universal to choose which agent gets it (Claude Code by default).",
        executableNote:
          "Installed locally, this skill's scripts run on your machine, not in a sandbox. Read them first — the CLI asks before installing.",
      },
      upstream: {
        heading: "Upstream installer — not verified by SourceWeft",
        lead: "The open-source skills installer fetches the same pinned commit, but does not check the files against the hashes SourceWeft recorded.",
      },
    },
    scan: {
      heading: "Automated scan notes",
      body: "Our automated scan flagged the following in this version. Flags are advisory — read the source before installing.",
    },
    details: {
      heading: "Skill details",
      slug: "Slug",
      name: "Name",
      author: "Author",
      type: "Type",
      trust: "Trust",
      listed: "Listed",
      updated: "Updated",
      unverified: "Community",
      featuredAndVerified: "Featured, Verified",
    },
    attribution: {
      heading: "Source and attribution",
      source: "Source:",
      inDirectory: "in",
      atCommit: "at commit",
      unknownSource: "source repository not recorded",
      license: "License:",
      ownership:
        "Content belongs to its original authors. SourceWeft indexes it from a public repository.",
      report: "Report or request removal",
    },
    related: {
      sameRepository: (repository: string) => `More from ${repository}`,
      sameCategory: (category: string) => `More in ${category}`,
    },
  },
  faqHeading: "Skills FAQ",
  faqTitle: "Agent skill basics",
  faq: [
    {
      question: "What is an agent skill?",
      answer:
        "A skill is a folder with a SKILL.md file of instructions, plus optional scripts and reference files. An AI agent loads it on demand to follow a specific workflow well.",
    },
    {
      question: "How do I use a skill in SourceWeft?",
      answer:
        "Open the skill, choose Add to SourceWeft, and add it to a workspace from your dashboard. You can also paste a skill's page link in chat and ask the assistant to install it.",
    },
    {
      question: "Can I install a skill without SourceWeft?",
      answer:
        "Yes. Run npx @sourceweft/cli skills install followed by the skill's name to install it for Claude Code, Codex, Cursor or another local agent. The CLI checks every file against the hashes recorded when the skill was scanned and installs nothing if one differs.",
    },
    {
      question: "Where do these skills come from?",
      answer:
        "Skills are indexed from public repositories. Each page links the source repository and the exact commit, and shows the license the author chose. The content belongs to its original authors.",
    },
    {
      question: "Are skills safe to install?",
      answer:
        "Skills are third-party content. Every version is scanned automatically and Verified skills were reviewed by SourceWeft, but you should still read the SKILL.md and file list, especially for skills that include scripts.",
    },
    {
      question: "How do I get my skill removed?",
      answer:
        "Use the Report or request removal link on the skill's page, or email support@sourceweft.com. We remove the listing and do not list it again.",
    },
  ],
  // Advisory scan flags in words. An unknown flag is shown as it is rather than
  // hidden.
  scanFlagLabels: {
    "egress:pipe-to-shell": "Fetches and runs remote code (curl | sh)",
    "egress:base64-exec": "Decodes and runs encoded commands",
    "egress:external-post": "Posts data to an external host",
    "egress:fetch": "Makes outbound network calls",
    "injection:override":
      "Contains text that tries to override the assistant's instructions",
    "injection:system-prompt": "Mentions the system prompt",
    "secrets:read-credentials": "Reads credential files",
    "secrets:env-access": "Reads environment variables",
    "scope:other-skill-file": "Reads another skill's files",
    "tool:sensitive": "Requests code-execution tools",
    "binary:executable": "Ships an executable binary",
  } as Record<string, string>,
} as const;
