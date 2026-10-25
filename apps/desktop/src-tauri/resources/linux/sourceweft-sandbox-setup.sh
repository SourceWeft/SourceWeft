#!/bin/sh
# SourceWeft local sandbox: one-time privileged setup (Linux).
#
#   sourceweft-sandbox-setup install
#   sourceweft-sandbox-setup uninstall
#
# install copies the system bubblewrap to /opt/sourceweft/libexec/bwrap and gives that one
# path its own AppArmor profile that grants user namespaces. It never touches /usr/bin/bwrap,
# any other AppArmor profile, or any sysctl (so Ubuntu 24.04 keeps
# kernel.apparmor_restrict_unprivileged_userns=1 for everything else). uninstall removes
# exactly what install created. Both are idempotent and need root.
#
# This single script is shipped in the .deb (run by its maintainer scripts) and embedded in
# the app (run through pkexec for AppImage installs), and CI runs this same file.
#
# The script must stay free of single quote characters: the app passes it to
# "/bin/sh -c" inside a single-quoted shell command shown to the user.
#
# --root <dir> is for the test suite only. It runs the script against a fake root directory
# without needing root, skips ownership changes, and looks for apparmor_parser only inside
# that directory. It must come before the command.
set -eu
# Directories the script creates must be traversable whatever umask pkexec or the caller had.
umask 022

PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

BWRAP_SOURCE=/usr/bin/bwrap
LIBEXEC_DIR=/opt/sourceweft/libexec
BWRAP_TARGET=$LIBEXEC_DIR/bwrap
PROFILE_DIR=/etc/apparmor.d
PROFILE_FILE=$PROFILE_DIR/sourceweft-bwrap

ROOT=
if [ "${1:-}" = "--root" ]; then
  if [ "$#" -lt 2 ] || [ -z "$2" ]; then
    echo "sourceweft-sandbox-setup: --root needs a directory" >&2
    exit 2
  fi
  ROOT=${2%/}
  shift 2
fi

ACTION=${1:-}
if [ "$#" -ne 1 ] || { [ "$ACTION" != "install" ] && [ "$ACTION" != "uninstall" ]; }; then
  echo "usage: sourceweft-sandbox-setup install|uninstall" >&2
  exit 2
fi

if [ -z "$ROOT" ] && [ "$(id -u)" != "0" ]; then
  echo "sourceweft-sandbox-setup: this must run as root (use pkexec or sudo)." >&2
  exit 1
fi

find_apparmor_parser() {
  if [ -n "$ROOT" ]; then
    if [ -x "$ROOT/sbin/apparmor_parser" ]; then
      echo "$ROOT/sbin/apparmor_parser"
    fi
  else
    command -v apparmor_parser || true
  fi
}

TMP_FILES=
cleanup() {
  for file in $TMP_FILES; do
    rm -f "$file"
  done
}
trap cleanup EXIT

# Files are written next to their destination and renamed into place, so a reader never sees
# a half-written file; stage registers a temporary file for removal if the script fails.
stage() {
  TMP_FILES="$TMP_FILES $1"
}

# An existing directory we are about to write into must be a real directory owned by root: a
# symlink, or a directory someone else owns, would let another user steer the root-owned files
# written below. (Under --root the files belong to the test user, so only the link check runs.)
require_root_owned_dir() {
  if [ -L "$1" ]; then
    echo "sourceweft-sandbox-setup: ${1#"$ROOT"} is a symbolic link; refusing to install through it." >&2
    exit 1
  fi
  if [ -e "$1" ]; then
    if [ ! -d "$1" ]; then
      echo "sourceweft-sandbox-setup: ${1#"$ROOT"} exists and is not a directory." >&2
      exit 1
    fi
    if [ -z "$ROOT" ] && [ "$(stat -c %u "$1")" != "0" ]; then
      echo "sourceweft-sandbox-setup: ${1#"$ROOT"} is not owned by root; refusing to install into it." >&2
      exit 1
    fi
  fi
}

do_install() {
  source_path=$ROOT$BWRAP_SOURCE
  if [ ! -f "$source_path" ] || [ ! -x "$source_path" ]; then
    echo "sourceweft-sandbox-setup: $BWRAP_SOURCE was not found. Install the bubblewrap package (for example: apt install bubblewrap) and run this setup again." >&2
    exit 1
  fi

  target=$ROOT$BWRAP_TARGET
  require_root_owned_dir "$ROOT/opt/sourceweft"
  require_root_owned_dir "$ROOT$LIBEXEC_DIR"
  mkdir -p "$ROOT$LIBEXEC_DIR"
  tmp_bwrap=$target.tmp.$$
  stage "$tmp_bwrap"
  cp "$source_path" "$tmp_bwrap"
  if [ -z "$ROOT" ]; then
    chown root:root "$tmp_bwrap"
  fi
  chmod 0755 "$tmp_bwrap"
  mv -f "$tmp_bwrap" "$target"

  parser=$(find_apparmor_parser)
  if [ -n "$parser" ] || [ -d "$ROOT$PROFILE_DIR" ]; then
    mkdir -p "$ROOT$PROFILE_DIR"
    profile=$ROOT$PROFILE_FILE
    tmp_profile=$profile.tmp.$$
    stage "$tmp_profile"
    cat > "$tmp_profile" <<PROFILE
profile sourceweft-bwrap $BWRAP_TARGET flags=(unconfined) {
  userns,
}
PROFILE
    if [ -z "$ROOT" ]; then
      chown root:root "$tmp_profile"
    fi
    chmod 0644 "$tmp_profile"
    mv -f "$tmp_profile" "$profile"
    if [ -n "$parser" ]; then
      "$parser" -r "$profile"
    fi
  else
    echo "sourceweft-sandbox-setup: AppArmor was not found, so no profile was written." >&2
  fi
  echo "sourceweft-sandbox-setup: installed $BWRAP_TARGET"
}

do_uninstall() {
  profile=$ROOT$PROFILE_FILE
  parser=$(find_apparmor_parser)
  if [ -n "$parser" ] && [ -f "$profile" ]; then
    # A profile that is not loaded (already unloaded, or AppArmor disabled) must not stop
    # the files from being removed.
    "$parser" -R "$profile" || echo "sourceweft-sandbox-setup: could not unload the AppArmor profile; removing its file anyway." >&2
  fi
  rm -f "$profile" "$ROOT$BWRAP_TARGET"
  # Only removes the directories when nothing else (for example the package script) is in them.
  rmdir "$ROOT$LIBEXEC_DIR" 2> /dev/null || true
  rmdir "$ROOT/opt/sourceweft" 2> /dev/null || true
  echo "sourceweft-sandbox-setup: removed $BWRAP_TARGET and its AppArmor profile"
}

if [ "$ACTION" = "install" ]; then
  do_install
else
  do_uninstall
fi
