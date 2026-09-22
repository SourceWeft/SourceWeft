# Manual Docker image publication

User-approved design, 2026-09-23.

Extend the existing CI workflow with workflow_dispatch and a required commit input. Resolve a 7–40 character hexadecimal commit to its complete SHA and require it to belong to origin/main. Ordinary push, pull_request and workflow_call runs retain their existing checked-out revision and never publish images.

Every quality job and the Docker image publication job checks out the resolved SHA. Keep existing lint, type, dependency, unit, CLI, HTML, Compose and image startup checks. Publication waits for all required jobs. Only the publication job receives packages:write, and only a manual main-branch workflow run can execute it.

Build the existing Dockerfile for linux/amd64 and linux/arm64, preserving the existing release platform coverage. Publish ghcr.io/<lowercase repository>:sha-<full SHA>, with source revision and build metadata. Record the registry digest in the workflow summary and output; deployments use that immutable digest. Repeat runs reuse an existing commit tag instead of replacing it. Missing registry tags permit building; authentication and other registry errors fail explicitly. Never update latest, version tags, desktop artifacts or production configuration.

The existing Docker smoke tests cover amd64. Both architectures must build successfully; ARM runtime smoke coverage is not added by this change. Validate workflow syntax and event/permission/commit propagation contracts, then exercise the manual workflow in GitHub Actions.

Deployment is a separate authorized operation. The production SSH host-key mismatch must be independently resolved before contacting that server or deploying. The deployed revision predates database migrations 0039–0050, so inspect migration state, backup and skill marketplace activation before upgrading all four application services.
