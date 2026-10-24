#!/bin/sh
# Stub shell used only by the `output_without_sentinels_falls_back_to_system_path` test in
# apps/desktop/src-tauri/src/local_host/readiness.rs, to simulate a shell that runs the
# requested command successfully but never prints the expected sentinel-wrapped PATH (for
# example, a shell whose `-lc` doesn't behave as expected, or output that got swallowed by a
# profile script's own redirection). Exits 0 with plain output and no sentinels at all.
printf 'just some unrelated output, no sentinels here'
