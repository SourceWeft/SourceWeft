#!/bin/sh
# Debian maintainer script (postinst) for the SourceWeft .deb. After the files are unpacked and
# bubblewrap (a dependency) is configured, copy bubblewrap to its scoped path and load its
# AppArmor profile. Runs on first install and on every upgrade so the copy follows the system
# bubblewrap.
#
# A failure must not leave the package half-configured, so it is reported loudly and the
# install continues; SourceWeft then reports local execution as needing setup and shows why.
set -e

case "$1" in
  configure)
    if ! /opt/sourceweft/libexec/sourceweft-sandbox-setup install; then
      # The setup script exits 0 when AppArmor is simply absent (it says so itself), so this
      # only runs when a step really failed; the messages above name the step, and the files
      # may be partly installed.
      echo "sourceweft: the local sandbox setup exited with an error (see the messages above). Local execution will report that it needs setup." >&2
      echo "sourceweft: fix the problem, then run: sudo /opt/sourceweft/libexec/sourceweft-sandbox-setup install" >&2
    fi
    ;;
esac

exit 0
