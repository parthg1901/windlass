#!/bin/sh
# Installs a built executable for this machine into a user-level bin directory.
# Local use only: it downloads nothing, never uses sudo, and changes no shell
# profile file unless you say yes when it asks.
#
#   sh scripts/install.sh                     install dist/<binary>-<os>-<arch> (built by scripts/build.ts)
#   sh scripts/install.sh <executable>        install that executable
#   sh scripts/install.sh --uninstall         remove what an earlier install put there
#   sh scripts/install.sh --check             only check the run-time requirements
#
# Options: --bin-dir <dir> (default: $XDG_BIN_HOME, else ~/.local/bin), --yes
# (answer the profile question with yes), --no-profile (do not ask).
#
# The installed name comes from the executable's file name, <binary>-<os>-<arch>,
# which scripts/build.ts takes from the product's brand; nothing here names it.
set -eu

die() { printf 'install: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(dirname -- "$here")
bin_dir=${XDG_BIN_HOME:-$HOME/.local/bin}
mode=install
exe=
profile=ask

while [ $# -gt 0 ]; do
  case $1 in
    --uninstall) mode=uninstall ;;
    --check) mode=check ;;
    --bin-dir) [ $# -ge 2 ] || die "--bin-dir needs a directory"; bin_dir=$2; shift ;;
    --yes) profile=yes ;;
    --no-profile) profile=no ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$exe" ] || die "one executable at a time"; exe=$1 ;;
  esac
  shift
done

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case $(uname -m) in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) arch=$(uname -m) ;;
esac
platform=$os-$arch

# The binary's name: from the executable's file name, or from the build's record.
binary_name() {
  base=$(basename -- "$1")
  case $base in
    *-"$platform") printf '%s\n' "${base%-"$platform"}" ;;
    *) printf '%s\n' "$base" ;;
  esac
}
built_binary() {
  info=$root/dist/build-info.json
  [ -f "$info" ] || return 1
  sed -n 's/^ *"binary": *"\([^"]*\)".*/\1/p' "$info" | head -n 1
}

check_requirements() {
  say "Run-time requirements on this machine ($platform):"
  missing=0
  if [ "$os" = linux ]; then
    if bwrap_path=$(command -v bwrap 2>/dev/null); then
      # The same probe the program runs: a throwaway sandbox with the namespaces it uses.
      if probe=$("$bwrap_path" --die-with-parent --unshare-user-try --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try --unshare-net \
          --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp -- true 2>&1); then
        say "  ok       bwrap ($bwrap_path): commands run in the sandbox"
      else
        missing=1
        say "  BROKEN   bwrap ($bwrap_path) cannot create a sandbox here: ${probe:-no message}"
        if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then
          say "           AppArmor blocks unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1)."
          say "           An administrator can add an AppArmor profile for bwrap; see docs/troubleshooting.md."
        fi
        say "           Cost: no command runs sandboxed; in the default mode every command asks first."
      fi
    else
      missing=1
      say "  MISSING  bwrap (bubblewrap): without it no command runs sandboxed, and in the default"
      say "           approval mode every command asks first (one-shot runs refuse them)."
      say "           Install it with your package manager, e.g. apt install bubblewrap."
    fi
    env_path=/usr/bin/env
    [ -x "$env_path" ] || env_path=$(command -v env 2>/dev/null || echo env)
    if "$env_path" --ignore-signal=TERM --default-signal=TERM true >/dev/null 2>&1; then
      say "  ok       env (GNU coreutils 8.31 or newer): a stopped command gets its grace period"
    else
      missing=1
      say "  OLD      env without --ignore-signal (GNU coreutils older than 8.31, or not GNU): a"
      say "           stopped sandboxed command is killed at once instead of being given time to finish."
    fi
  elif [ "$os" = darwin ]; then
    if [ -x /usr/bin/sandbox-exec ]; then
      say "  ok       sandbox-exec: commands run in the sandbox (never tested on macOS)"
    else
      missing=1
      say "  MISSING  /usr/bin/sandbox-exec: no command runs sandboxed; every command asks first."
    fi
  else
    missing=1
    say "  NONE     no sandbox exists for $os"
  fi
  if git_version=$(git --version 2>/dev/null); then
    say "  ok       $git_version: snapshots, undo and redo"
  else
    missing=1
    say "  MISSING  git: snapshots need git 2.25 or newer; without it /undo and /redo cannot restore files."
  fi
  return $missing
}

case $mode in
  check)
    check_requirements || true
    exit 0
    ;;
  uninstall)
    name=${exe:+$(binary_name "$exe")}
    name=${name:-$(built_binary || true)}
    [ -n "$name" ] || die "cannot tell the binary's name: pass the executable you installed, or build first"
    target=$bin_dir/$name
    if [ -e "$target" ]; then
      rm -f -- "$target"
      say "removed $target"
    else
      say "nothing to remove: $target does not exist"
    fi
    say "Your sessions and sign-in are kept. To delete them too, see \"Deleting everything\" in docs/user-guide.md."
    exit 0
    ;;
esac

if [ -z "$exe" ]; then
  name=$(built_binary) || die "no build found: run \`bun scripts/build.ts\` first, or pass an executable"
  exe=$root/dist/$name-$platform
fi
[ -f "$exe" ] || die "$exe does not exist (build it with \`bun scripts/build.ts\`)"
name=$(binary_name "$exe")
case $(basename -- "$exe") in
  *-linux-*|*-darwin-*)
    case $(basename -- "$exe") in *-"$platform") ;; *) die "$exe is not built for this machine ($platform)" ;; esac
    ;;
esac

# Run it before installing: an executable for another platform, or a broken one, stops here.
version=$("$exe" --version 2>&1) || die "$exe does not run here: $version"

mkdir -p -- "$bin_dir"
tmp=$bin_dir/.$name.installing.$$
cp -- "$exe" "$tmp"
chmod 755 "$tmp"
mv -f -- "$tmp" "$bin_dir/$name"
say "installed $bin_dir/$name: $version"
say ""
check_requirements || say "The program runs without these; the lines above say what each one costs."

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    line="export PATH=\"$bin_dir:\$PATH\""
    say ""
    say "$bin_dir is not on your PATH. Add this line to your shell's profile:"
    say "  $line"
    rc=
    case ${SHELL:-} in
      */zsh) rc=$HOME/.zshrc ;;
      */bash) rc=$HOME/.bashrc ;;
    esac
    if [ -n "$rc" ] && [ "$profile" != no ]; then
      answer=n
      if [ "$profile" = yes ]; then answer=y
      elif [ -t 0 ]; then printf 'Add it to %s now? [y/N] ' "$rc"; read -r answer || answer=n
      fi
      case $answer in
        y|Y|yes) printf '\n%s\n' "$line" >> "$rc"; say "added to $rc; open a new shell to use it" ;;
        *) say "left $rc unchanged" ;;
      esac
    fi
    ;;
esac
