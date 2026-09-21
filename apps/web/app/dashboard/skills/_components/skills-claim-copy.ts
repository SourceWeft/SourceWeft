/**
 * Every user-facing string of author claims: the claim page, the panel on a
 * community skill's page, and the claim rows in the market admin panel — plus
 * that panel's "Featured" switch, which arrived with the same change. Kept
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
    methodsTitle: "Only the repository's owner can claim it",
    accountTitle: "With your GitHub account",
    accountBody:
      "For a repository under your personal GitHub account: we check that your linked GitHub account owns it. Collaborators and maintainers cannot claim a repository they do not own.",
    accountAction: "Claim with GitHub account",
    accountHints: {
      not_linked: "Link the GitHub account that owns this repository first.",
      organization:
        "This repository belongs to an organization, so it cannot be claimed here.",
      not_owner:
        "Your linked GitHub account does not own this repository, so it cannot claim it.",
    },
    linkGitHub: "Open security settings",
    organizationTitle: "Owned by an organization",
    organizationBody:
      "Only a repository's owner can claim it, and this one's owner is an organization, so no one can claim it for themselves. A SourceWeft admin grants the claim instead: email support from an address that shows you speak for the organization, and tell us which SourceWeft account should hold it.",
    organizationAction: "Email support to request the claim",
    verified: "Repository claimed. Its skills are now yours to manage.",
    yourClaims: "Your claims",
    noClaims: "You have not claimed any repositories yet.",
    suggestionsTitle: "Repositories you could claim",
    suggestionsBody:
      "These repositories belong to your linked GitHub account and have community skills here. Nothing changes until you claim one.",
    suggestionAction: "Claim",
    status: {
      verified: "Claimed",
      revoked: "Revoked",
    },
    methodLabel: {
      github_account: "GitHub account",
      // Retired; a claim recorded under it keeps its label.
      verification_file: "Verification file",
      admin_grant: "Granted by an admin",
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
      admin_grant: "granted by an admin",
    },
    grantTitle: "Grant claim",
    grantHint:
      "For an organization's repository, which no one can claim for themselves. The account behind this email becomes the repository's author.",
    grantEmailLabel: "Author's email",
    grantEmailPlaceholder: "author@example.com",
    grant: "Grant",
    grantedToast: "Claim granted",
    grantErrors: {
      SKILL_CLAIM_USER_NOT_FOUND: "No SourceWeft account uses that email.",
      SKILL_REPO_ALREADY_CLAIMED:
        "Someone already holds this repository. Revoke that claim first.",
      fallback: "The claim could not be granted.",
    },
    revoke: "Revoke claim",
    confirmRevokeTitle: "Revoke this author claim?",
    confirmRevokeBody:
      "The repository's skills lose the “Claimed by author” mark and go back to whoever first imported each of them. The author can claim again.",
    revokedToast: "Claim revoked",
  },
  featured: {
    label: "Featured",
    hint: "The platform's import features a short list of major publishers. Changing it here makes it your choice, which later imports leave alone.",
    setByAdmin: "Set by an admin",
    setBySync: "Set by the platform's import",
    featuredToast: "Skill featured",
    unfeaturedToast: "Skill no longer featured",
  },
  errors: {
    SKILL_CLAIM_REPO_NOT_FOUND:
      "No community skills on SourceWeft come from this repository, or GitHub does not know it.",
    SKILL_REPO_ALREADY_CLAIMED:
      "Another author has already claimed this repository.",
    SKILL_CLAIM_GITHUB_NOT_LINKED:
      "Link the GitHub account that owns this repository in settings first.",
    SKILL_CLAIM_ORGANIZATION_REPO:
      "This repository belongs to an organization, so only an admin can grant its claim. Email support@sourceweft.com to ask.",
    SKILL_CLAIM_ACCOUNT_MISMATCH:
      "Your linked GitHub account does not own this repository.",
    SKILL_CLAIM_REPO_MOVED:
      "This repository was renamed or moved on GitHub, so its skills here cannot be claimed under this name.",
    SKILL_CLAIM_NOT_FOUND: "This claim was not found.",
    SKILL_CLAIM_NOT_VERIFIED:
      "Only a claimed repository's author can do this.",
    SKILL_CLAIM_GITHUB_UNAVAILABLE:
      "GitHub could not be reached. Try again in a moment.",
    SKILL_CLAIM_USER_NOT_FOUND: "No SourceWeft account uses that email.",
    fallback: "Something went wrong. Try again.",
  },
} as const;
