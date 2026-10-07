# SourceWeft security-braces

This is SourceWeft's maintained MIT-licensed source fork of micromatch/braces
3.0.3, upstream commit `74b2db2938fad48a2ea54a9c8bf27a37a62c350d`.
`UPSTREAM.json` records the exact original source and test hashes. LICENSE is
unchanged. All 12 upstream test files are retained unchanged in upstream-test.

GHSA-vfj7-8cjw-p6xm has no published patched upstream version at adoption.
This package changes the actual parser and AST/array walkers: brace and
parenthesis nesting is limited to 100; cyclic or deeper externally supplied
ASTs and arrays throw SyntaxError. The fixed bound cannot be disabled through
options. Externally supplied ASTs must use ordinary array-valued nodes; dynamic
Proxy/getter mutation during traversal is outside this plain-AST contract.
Normal inputs preserve the full public API and lib entry points.
The AST validator ignores normal prev backlinks and checks parent chains
independently. Array flattening uses an explicit stack. Expansion's recursive
append helper is independently bounded.

The root braces override resolves to this workspace implementation. The
backend explicitly declares it so Turbo prune retains its manifest, source
and fill-range dependency. No original npm braces dependency or advisory
ignore is retained. Pristine source in tests/upstream-reference is a test-only
oracle for differential testing and is excluded from packaged runtime files.

SourceWeft owns maintenance of these changes. Each upstream release must be
reviewed for API changes and the security regression corpus; do not replace
this fork with a name-only wrapper. Migrate back only after an upstream fix
covers all protected entry points, passes these tests and the unchanged audit
gate, and is verified through micromatch, fast-glob, Daytona and deployment
pruning/frozen installation. Keep MIT attribution on all derived source.
