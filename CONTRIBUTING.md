# Contributing to SourceWeft

We use a small Issue → pull request workflow so a change has a clear reason, owner, and verification record.

1. Create or identify an Issue before work intended for `main`. Use the feature or bug form when it fits; use a blank Issue for maintenance or documentation. Large work can use a parent Issue with smaller deliverable Issues.
2. Write the expected result or acceptance criteria in the Issue. Keep public Issues and pull requests free of confidential plans, credentials, and private data.
3. Work on a branch and open a pull request targeting `main`. Link its Issue in the PR description. Use `Closes #number` only when the PR completes the Issue; use `Refs #number` for partial work.
4. Record what changed, what was verified, and any rollout risk in the PR. Resolve review comments and pass the relevant CI checks before merging.
5. Team members track the Issue on the private [SourceWeft Work board](https://github.com/orgs/SourceWeft/projects/1): Todo → In Progress → In Review → Done. A PR is linked to its Issue rather than added as a second card. Done means the Issue is closed after the final PR merges, not that a release was published.

Use the existing `enhancement` or `bug` label when appropriate; `documentation` is optional. Status, priority, and module labels are not part of this workflow. For urgent fixes, create a short Issue and PR, then complete the reproduction and verification details as soon as practical.
