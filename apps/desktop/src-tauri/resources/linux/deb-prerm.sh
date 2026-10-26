#!/bin/sh
# Debian maintainer script (prerm) for the SourceWeft .deb. Removes the bubblewrap copy and its
# AppArmor profile when the package is removed or purged, and leaves them alone on upgrade (the
# new version refreshes them in its postinst). It runs before the files are deleted, so the
# setup script is still present.
#
# A failure here must never block removing the package; it is reported and removal continues.
set -e

case "$1" in
  remove|purge)
    if ! /opt/sourceweft/libexec/sourceweft-sandbox-setup uninstall; then
      echo "sourceweft: could not fully remove the local sandbox files. Remove /opt/sourceweft/libexec/bwrap and /etc/apparmor.d/sourceweft-bwrap by hand." >&2
    fi
    ;;
esac

exit 0
