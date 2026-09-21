/**
 * Every user-facing string of author claims: the claim page, the panel on a
 * community skill's page, and the claim row in the market admin panel. Kept
 * apart from `skills-market-copy.ts` so the market and claims can change
 * independently; both are what gets swapped for message lookups once `main`
 * has an i18n library.
 */
export const skillsClaimCopy = {
  page: {
    title: "Claim a repository",
    back: "Back to skills",
    intro:
      "If you wrote the skills in a GitHub repository, claim it to take charge of how they appear on SourceWeft.",
    benefitsTitle: "Claiming gives you",
    benefits: [
      "Control over whether each of the repository's skills is listed on the public market.",
      "A “Claimed by author” mark on those skills.",
      "The option to remove them from SourceWeft's public market entirely.",
    ],
    benefitsNote:
      "Workspaces that already installed a skill keep it, whatever you decide.",
    repoLabel: "Repository",
    repoPlaceholder: "owner/repo",
    lookUp: "Look up",
    repoInvalid: "Enter a GitHub repository as owner/repo.",
    repoNotFound:
      "No community skills on SourceWeft come from this repository.",
    skillCount: (count: number) =>
      count === 1 ? "1 community skill" : `${count} community skills`,
    claimedByYou: "You have claimed this repository.",
    claimedBySomeone:
      "Another author has already claimed this repository. A market admin can review a claim that looks wrong.",
    methodsTitle: "Prove it is yours",
    accountTitle: "With your GitHub account",
    accountBody:
      "For a repository under your personal GitHub account: we check that your linked GitHub account owns it.",
    accountAction: "Claim with GitHub account",
    accountHints: {
      not_linked: "Link your GitHub account in settings first.",
      organization:
        "This repository belongs to an organization — use the verification file instead.",
      not_owner:
        "Your linked GitHub account does not own this repository — use the verification file instead.",
    },
    linkGitHub: "Open security settings",
    fileTitle: "With a verification file",
    fileBody:
      "Works for any repository you can push to, including an organization's.",
    fileAction: "Get a verification token",
    fileNewToken: "Get a new token",
    fileSteps: {
      create: "Create this file",
      branch: (branch: string) => `on the default branch (${branch})`,
      branchUnknown: "on the repository's default branch",
      contents: "with exactly this content:",
      then: "Commit and push it, then verify. You can delete the file afterwards.",
    },
    tokenOnce:
      "This token is shown only once. If you lose it, get a new one — the old one stops working.",
    tokenPending: (expires: string) =>
      `A verification is waiting. Its token was shown when you started it; it expires ${expires}.`,
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Could not copy — select the text and copy it yourself.",
    verify: "Verify",
    verified: "Repository claimed. Its skills are now yours to manage.",
    started: "Token created. Commit the file, then verify.",
    yourClaims: "Your claims",
    noClaims: "You have not claimed any repositories yet.",
    suggestionsTitle: "Repositories you could claim",
    suggestionsBody:
      "These repositories belong to your linked GitHub account and have community skills here. Nothing changes until you claim one.",
    suggestionAction: "Claim",
    status: {
      pending: "Waiting for verification",
      verified: "Claimed",
      revoked: "Revoked",
      expired: "Expired",
    },
    methodLabel: {
      github_account: "GitHub account",
      verification_file: "Verification file",
    },
    noWorkspace: "Open a workspace to claim a repository.",
    loadFailed: "Claims could not be loaded.",
    retry: "Retry",
  },
  panel: {
    title: "Author",
    claimedByYou: "Claimed by you",
    claimedByAuthor: "Claimed by the author",
    unclaimedBody:
      "Wrote the skills in this repository? Claim it to control how they appear here.",
    claimLink: "Claim this repository",
    manageLink: "Manage claim",
    remove: "Remove from SourceWeft",
    removeHint:
      "Takes every skill of this repository off the public market. Workspaces that installed them keep them.",
    confirmTitle: "Remove this repository's skills from SourceWeft?",
    confirmBody: (repo: string) =>
      `Every skill from ${repo} is taken off the public market and kept off it. Workspaces that already installed one keep using it. You can list a skill again later with its listing switch.`,
    confirm: "Remove",
    cancel: "Cancel",
    removedToast: (count: number) =>
      count === 1
        ? "1 skill removed from the public market"
        : `${count} skills removed from the public market`,
    removeFailed: "The repository's skills could not be removed.",
  },
  admin: {
    claim: "Author claim",
    unclaimed: "Not claimed",
    claimedBy: (userId: string) => `Claimed by user ${userId}`,
    method: {
      github_account: "via GitHub account",
      verification_file: "via verification file",
    },
    revoke: "Revoke claim",
    confirmRevokeTitle: "Revoke this author claim?",
    confirmRevokeBody:
      "The repository's skills lose the “Claimed by author” mark and go back to whoever first imported each of them. The author can claim again.",
    revokedToast: "Claim revoked",
  },
  errors: {
    SKILL_CLAIM_REPO_NOT_FOUND:
      "No community skills on SourceWeft come from this repository, or GitHub does not know it.",
    SKILL_REPO_ALREADY_CLAIMED:
      "Another author has already claimed this repository.",
    SKILL_CLAIM_GITHUB_NOT_LINKED:
      "Link your GitHub account in settings, or use the verification file.",
    SKILL_CLAIM_ORGANIZATION_REPO:
      "This repository belongs to an organization. Use the verification file.",
    SKILL_CLAIM_ACCOUNT_MISMATCH:
      "Your linked GitHub account does not own this repository.",
    SKILL_CLAIM_REPO_MOVED:
      "This repository was renamed or moved on GitHub, so its skills here cannot be claimed under this name.",
    SKILL_CLAIM_FILE_MISSING:
      "The verification file was not found on the default branch yet. Check the path and branch, push, and try again.",
    SKILL_CLAIM_FILE_MISMATCH:
      "The verification file does not contain this token. Check its content and try again.",
    SKILL_CLAIM_EXPIRED:
      "This verification expired. Get a new token to try again.",
    SKILL_CLAIM_NOT_FOUND: "This claim was not found.",
    SKILL_CLAIM_NOT_PENDING:
      "This claim is not waiting for verification. Start a new one.",
    SKILL_CLAIM_NOT_VERIFIED:
      "Only a claimed repository's author can do this.",
    SKILL_CLAIM_GITHUB_UNAVAILABLE:
      "GitHub could not be reached. Try again in a moment.",
    fallback: "Something went wrong. Try again.",
  },
} as const;
