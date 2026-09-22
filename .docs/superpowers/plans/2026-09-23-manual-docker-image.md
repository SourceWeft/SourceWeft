# Implementation plan

1. Add a revision-resolution job and a manual commit input to ci.yml. Reject invalid, unknown and non-main manual revisions. Propagate the resolved SHA to every checkout and revision-based artifact/cache key.
2. Add a manual-only Docker Image job after all quality checks. Use job-scoped package write permission, full-SHA tagging, build metadata and both existing release architectures. Preserve an existing commit tag and output its digest; fail on registry errors other than an absent manifest.
3. Add focused workflow and revision-resolution verification. Parse YAML, verify gates and SHA consistency, exercise the resolver against a temporary Git history, and run existing release config checks.
4. Commit and push the reviewed change, dispatch CI with a pinned complete commit, monitor all checks and publication, and verify GHCR digest and platforms.
5. Continue deployment only after the outstanding SSH identity confirmation and production migration preflight; record the exact image digest and prior version.
