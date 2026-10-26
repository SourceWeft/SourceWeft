#!/bin/sh
# Stub shell used only by the `login_shell_startup_banner_does_not_corrupt_the_path` test in
# apps/desktop/src-tauri/src/local_host/readiness.rs, to simulate a real login shell whose
# profile (.zshrc/.bash_profile/nvm's own init/etc.) prints startup chatter to stdout before
# the requested command's output.
#
# Invoked exactly like a real login shell (`$SHELL -lc '<printf with sentinels>'`), but ignores
# its arguments like slow-shell.sh does, printing a fixed banner followed by the same
# sentinel-wrapped PATH value production's `printf` would produce, so the test can assert
# `extract_path` strips the banner instead of treating it as (or corrupting) the PATH.
printf 'Welcome to Example Shell 1.0\nLoading profile...\n'
printf '__SW_SANDBOX_PATH_BEGIN__/banner/bin:/usr/bin:/bin__SW_SANDBOX_PATH_END__'
