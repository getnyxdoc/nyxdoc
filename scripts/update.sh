#!/usr/bin/env bash

set -Eeuo pipefail
# shellcheck source-path=SCRIPTDIR
# shellcheck source=compose-common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/compose-common.sh"

usage() {
  cat <<'EOF'
Usage: ./scripts/update.sh [--channel stable|main] [--build]

Create a verified backup, move only to a descendant release or main revision,
start the new containers, run migrations automatically, and verify health.
EOF
}

channel="${NYXDOC_UPDATE_CHANNEL:-stable}"
build_local=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --channel)
      [ "$#" -ge 2 ] || nyxdoc_die "--channel requires stable or main."
      channel="$2"
      shift 2
      ;;
    --build) build_local=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; nyxdoc_die "Unknown argument: $1" ;;
  esac
done
[ "$channel" = stable ] || [ "$channel" = main ] \
  || nyxdoc_die "Update channel must be stable or main."
[ "$channel" != main ] || $build_local \
  || nyxdoc_die "The main channel is source-only; use --channel main --build."

nyxdoc_require_compose
nyxdoc_require_environment
nyxdoc_require_command git
nyxdoc_require_command curl
nyxdoc_validate_environment

git -C "$NYXDOC_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || nyxdoc_die "The updater requires a Git checkout."
[ -z "$(git -C "$NYXDOC_ROOT" status --porcelain --untracked-files=normal)" ] \
  || nyxdoc_die "The Git working tree is not clean. Commit, stash, or remove local changes first."

current_revision="$(git -C "$NYXDOC_ROOT" rev-parse HEAD)"
git -C "$NYXDOC_ROOT" fetch --tags --prune origin
if [ "$channel" = stable ]; then
  target_ref="$(git -C "$NYXDOC_ROOT" tag --list 'v[0-9]*' --sort=-v:refname | head -n 1)"
  [ -n "$target_ref" ] || nyxdoc_die "No stable v* release tag was found on origin."
else
  target_ref="origin/main"
fi
target_revision="$(git -C "$NYXDOC_ROOT" rev-parse "${target_ref}^{commit}")"

if [ "$current_revision" = "$target_revision" ]; then
  nyxdoc_info "Already on $target_ref ($target_revision); no update is required."
  nyxdoc_wait_for_services
  exit 0
fi

git -C "$NYXDOC_ROOT" merge-base --is-ancestor "$current_revision" "$target_revision" \
  || nyxdoc_die "Target $target_ref is not a fast-forward descendant of the current revision."

[ -n "$(nyxdoc_compose ps --status running -q app)" ] \
  || nyxdoc_die "The app service must be running so a verified pre-update backup can be created."

nyxdoc_info "Creating and verifying a backup before changing source or containers."
backup_output="$(nyxdoc_compose exec -T --user node app npm run backup:create)"
printf '%s\n' "$backup_output"
backup_generation="$(printf '%s\n' "$backup_output" | sed -n 's/^[[:space:]]*"generationPath":[[:space:]]*"\([^"]*\)".*/\1/p' | tail -n 1)"

failed=true
on_exit() {
  if $failed; then
    printf '[nyxdoc] update failed. Previous source revision: %s\n' "$current_revision" >&2
    [ -z "$backup_generation" ] \
      || printf '[nyxdoc] verified backup: %s\n' "$backup_generation" >&2
    printf '[nyxdoc] automatic database rollback was not attempted. See DEPLOYMENT.md.\n' >&2
  fi
}
trap on_exit EXIT

git -C "$NYXDOC_ROOT" checkout --detach "$target_revision"
version="$(nyxdoc_package_version)"
source_revision="$(nyxdoc_source_revision)"
current_image="$(nyxdoc_env_get NYXDOC_IMAGE)"

if $build_local || [[ "$current_image" == nyxdoc-app:* ]]; then
  image="nyxdoc-app:${version}"
  nyxdoc_env_set NYXDOC_IMAGE "$image"
  nyxdoc_info "Building $image at $source_revision."
  nyxdoc_compose config --quiet
  nyxdoc_compose build --build-arg "SOURCE_REVISION=$source_revision"
else
  case "$current_image" in
    ""|ghcr.io/getnyxdoc/nyxdoc:*)
      image="ghcr.io/getnyxdoc/nyxdoc:${version}"
      nyxdoc_env_set NYXDOC_IMAGE "$image"
      ;;
    *) image="$current_image" ;;
  esac
  nyxdoc_info "Pulling $image."
  nyxdoc_compose config --quiet
  nyxdoc_compose pull app collaboration gateway
fi

nyxdoc_compose up -d --no-build --remove-orphans
nyxdoc_wait_for_services
nyxdoc_compose ps
failed=false
trap - EXIT

nyxdoc_info "Updated $current_revision -> $source_revision using channel $channel."
[ -z "$backup_generation" ] || nyxdoc_info "Pre-update verified backup: $backup_generation"
