#!/bin/sh
# Stub shell used only by the `slow_login_shell_falls_to_system_path` test in
# apps/desktop/src-tauri/src/local_host/readiness.rs, to simulate a login shell whose profile
# hangs well past the production 5s user_path() timeout.
#
# Invoked exactly like a real login shell (`$SHELL -lc 'printf %s "$PATH"'`), but ignores its
# arguments and always sleeps past the timeout instead, so the test can assert the fallback
# PATH and System kind without needing a genuinely broken shell on the test host.
sleep 10
