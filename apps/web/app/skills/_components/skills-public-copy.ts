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
          "Verified skills first, then the ones workspaces install most.",
      },
      newest: {
        title: "Newest",
        description: "Skills most recently listed in the directory.",
      },
      popular: {
        title: "Most installed",
        description: "The skills SourceWeft workspaces add most often.",
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
          "Use it in chat — or just ask the assistant to install it by name.",
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
    popular: "Most installed",
    new: "Newest",
    name: "Name",
  },
  trustOptions: {
    all: "Any trust",
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
    executable: "Includes scripts",
    promptOnly: "Instructions only",
  },
  card: {
    installs: (count: string) =>
      count === "1" ? "1 install" : `${count} installs`,
    unknownAuthor: "Unknown author",
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
    installs: (count: string) =>
      count === "1" ? "1 install" : `${count} installs`,
    facts: {
      version: "Version",
      license: "License",
      installs: "Installs",
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
    },
    install: {
      heading: "Add to SourceWeft",
      cta: "Add to SourceWeft",
      steps: [
        "Open the skill in your dashboard and add it to a workspace.",
        "Enable it for the chats that should use it.",
      ],
      signedOutNote:
        "You will be asked to sign in first, then taken straight to this skill.",
      chatLead: "or just ask in chat:",
      chatPrompt: (name: string) => `install ${name}`,
      copy: "Copy",
      executableNote:
        "This skill includes scripts. They run in your workspace sandbox when the skill is used — review the file list and source before adding it.",
      promptOnlyNote:
        "This skill is instructions only: it ships no scripts to execute.",
      local: {
        heading: "Install on your own machine",
        lead: "For Claude Code, Codex, Cursor and other local agents. SourceWeft indexes this skill and does not host its files, so the command fetches it from the source repository — pinned to the exact commit that was scanned here.",
        executableNote:
          "Installed locally, this skill's scripts run on your machine, not in a sandbox. Read them first.",
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
    related: (name: string) => `More skills like ${name}`,
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
        "Open the skill, choose Add to SourceWeft, and add it to a workspace from your dashboard. You can also ask the assistant in chat to install a skill by name.",
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
