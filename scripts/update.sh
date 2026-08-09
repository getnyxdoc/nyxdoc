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
With --build, build the selected checkout locally instead of trusting an
official GHCR image from a potentially different Git history.

Set NYXDOC_UPDATE_AUTHORITY=official or origin in .env.production to choose
which Git lineage stable updates follow. New installations set official;
older installations are migrated once from their existing configuration.
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
nyxdoc_require_command sha256sum
nyxdoc_validate_environment
removed_legacy_source_revision=false
if nyxdoc_env_remove NYXDOC_SOURCE_REVISION; then
  removed_legacy_source_revision=true
  nyxdoc_info "Removed legacy NYXDOC_SOURCE_REVISION override; image provenance is authoritative."
fi
[ "$channel" != stable ] || nyxdoc_require_buildx

git -C "$NYXDOC_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || nyxdoc_die "The updater requires a Git checkout."
# A failed update leaves its verified-backup receipt here so a later retry can
# resume safely. It is operational state, not a local source modification.
dirty_paths="$(git -C "$NYXDOC_ROOT" status --porcelain --untracked-files=normal -- . ':(exclude).nyxdoc-update-state')"
[ -z "$dirty_paths" ] \
  || nyxdoc_die "The Git working tree is not clean. Commit, stash, or remove local changes first."

current_revision="$(git -C "$NYXDOC_ROOT" rev-parse HEAD)"
current_image="$(nyxdoc_env_get NYXDOC_IMAGE)"
update_image_override="${NYXDOC_UPDATE_IMAGE:-}"
state_file="$(nyxdoc_update_state_file)"
receipt_image=""
receipt_format=""
update_authority=""
authority_was_explicit=false
if [ -f "$state_file" ]; then
  receipt_format="$(nyxdoc_update_state_get "$state_file" format)"
  receipt_image="$(nyxdoc_update_state_get "$state_file" targetImage)"
  if [ -n "$receipt_image" ]; then
    [[ "$receipt_image" != *[[:space:]]* ]] \
      || nyxdoc_die "The interrupted-update receipt contains an invalid target image."
  fi
fi

if nyxdoc_update_authority_is_explicit; then authority_was_explicit=true; fi
resolved_authority="$(nyxdoc_update_authority "$current_image" "$update_image_override")"
if [ "$receipt_format" = "nyxdoc-update-state/v3" ]; then
  receipt_authority="$(nyxdoc_update_state_get "$state_file" updateAuthority)"
  case "$receipt_authority" in official|origin) ;; *) nyxdoc_die "The interrupted-update receipt contains an invalid update authority." ;; esac
  if $authority_was_explicit && [ "$resolved_authority" != "$receipt_authority" ]; then
    nyxdoc_die "The interrupted-update receipt belongs to update authority $receipt_authority, but .env.production selects $resolved_authority. Preserve the receipt and resolve that mismatch explicitly."
  fi
  update_authority="$receipt_authority"
else
  update_authority="$resolved_authority"
fi

[ "$channel" != main ] || [ "$update_authority" = origin ] \
  || nyxdoc_die "The main channel always follows origin; set NYXDOC_UPDATE_AUTHORITY=origin and use --channel main --build."
if [ "$update_authority" = official ]; then
  if [ "$channel" != stable ] || $build_local; then
    nyxdoc_die "Official update authority supports only stable verified GitHub releases; use NYXDOC_UPDATE_AUTHORITY=origin for --build or main."
  fi
fi

resuming_interrupted=false
resumable_backup=""
if [ -f "$state_file" ]; then
  nyxdoc_validate_resumable_update_context "$current_revision" "$update_authority" "$current_image" \
    || nyxdoc_die "The interrupted-update receipt does not match the current source, update authority, or configured image. Preserve it for diagnosis; no newer target was resolved."
  recovery_target="$(nyxdoc_resumable_update_target "$current_revision")" \
    || nyxdoc_die "The interrupted-update receipt is invalid or does not belong to the current checkout. Preserve it for diagnosis; no newer target was resolved."
  IFS=$'\t' read -r target_revision target_label <<<"$recovery_target"
  target_ref="$target_revision"
  resumable_backup="$(nyxdoc_resumable_update_backup "$current_revision" "$target_revision")" \
    || nyxdoc_die "The interrupted-update backup receipt or payload failed verification. No newer target was resolved."
  resuming_interrupted=true
  nyxdoc_info "Recovering the receipt target $target_label ($target_revision) before checking for a newer release."
else
  update_source_kind="$update_authority"
  target_selection="$(nyxdoc_resolve_update_target "$channel" "$update_source_kind")"
  IFS=$'\t' read -r target_ref target_label <<<"$target_selection"
  target_revision="$(git -C "$NYXDOC_ROOT" rev-parse "${target_ref}^{commit}")"
fi
source_changed=false
if $resuming_interrupted && [ -z "$update_image_override" ]; then
  if [ -n "$receipt_image" ]; then
    update_image_override="$receipt_image"
  fi
fi
image_prepared=false
target_version="$(nyxdoc_package_version_at_revision "$target_revision")"

if [ "$current_revision" != "$target_revision" ]; then
  source_changed=true
  if ! git -C "$NYXDOC_ROOT" merge-base --is-ancestor "$current_revision" "$target_revision"; then
    if [ "$update_authority" = official ]; then
      current_version="$(nyxdoc_package_version)"
      version_relation="$(nyxdoc_compare_stable_versions "$current_version" "$target_version")"
      [ "$version_relation" -le 0 ] \
        || nyxdoc_die "Official target $target_label ($target_version) is older than the installed version $current_version."
      nyxdoc_info "Switching to the explicitly selected canonical official release commit for $target_label; origin remains unchanged."
    else
      nyxdoc_die "Target $target_label is not a fast-forward descendant of the current revision."
    fi
  fi
  if ! $build_local; then
    nyxdoc_require_explicit_image_for_source_advance \
      "$current_image" "$update_image_override"
  fi
fi

if $build_local || [[ "$current_image" == nyxdoc-app:* ]]; then
  target_image="nyxdoc-app:${target_version}"
else
  target_image="$(nyxdoc_select_update_image \
    "$current_image" "$target_version" "$update_image_override")"
fi
if [ -z "$target_image" ] || [[ "$target_image" == *[[:space:]]* ]]; then
  nyxdoc_die "The selected update image is invalid."
fi

if ! $build_local && nyxdoc_is_official_release_image "$target_image"; then
  target_image="$(nyxdoc_pin_official_release_image "$target_image")"
  nyxdoc_info "Pulling the immutable official release image $target_image for provenance verification."
  NYXDOC_IMAGE="$target_image" nyxdoc_compose pull app collaboration gateway
  nyxdoc_verify_official_image_revision "$target_image" "$target_revision"
  image_prepared=true
fi

if ! $source_changed; then
  desired_image="$target_image"

  if ! $build_local && [ "$current_image" = "$desired_image" ]; then
    nyxdoc_compose config --quiet
    if [[ "$desired_image" != nyxdoc-app:* ]]; then
      nyxdoc_info "Checking the configured release image before declaring the update complete."
      nyxdoc_compose pull app collaboration gateway
      nyxdoc_verify_official_image_revision "$desired_image" "$target_revision"
      image_prepared=true
    fi
    if nyxdoc_services_use_image "$desired_image" && ! $removed_legacy_source_revision; then
      if ! $authority_was_explicit; then
        nyxdoc_env_set NYXDOC_UPDATE_AUTHORITY "$update_authority"
        nyxdoc_info "Persisted NYXDOC_UPDATE_AUTHORITY=$update_authority for future deterministic updates."
      fi
      nyxdoc_info "Already on $target_label ($target_revision) with $desired_image; no update is required."
      nyxdoc_wait_for_services
      nyxdoc_clear_update_state
      exit 0
    fi
    nyxdoc_info "Source and image configuration are current, but running services require reconciliation."
  else
    nyxdoc_info "Source is already on $target_label, but the configured image requires reconciliation."
  fi
fi

backup_generation=""
backup_generation_id=""
backup_source_revision=""
previous_configured_image="$current_image"
previous_running_image_id=""
previous_running_image_digest=""
app_running="$(nyxdoc_compose ps --status running -q app)"
if $resuming_interrupted; then
  IFS=$'\t' read -r backup_generation_id backup_generation <<<"$resumable_backup"
  if [ -n "$app_running" ]; then
    nyxdoc_info "Resuming the interrupted update with its verified pre-update backup."
  else
    nyxdoc_info "The app is not running; resuming the interrupted update with its verified pre-update backup."
  fi
elif [ -n "$app_running" ]; then
  nyxdoc_services_use_image "$current_image" \
    || nyxdoc_die "The running services do not all use the configured NYXDOC_IMAGE. Reconcile or restore that known-good state before updating."
  nyxdoc_verify_image_source_revision "$current_image" "$current_revision"
  running_identity="$(nyxdoc_capture_running_image_identity)" \
    || nyxdoc_die "Could not capture one consistent running image identity before backup."
  IFS=$'\t' read -r previous_running_image_id previous_running_image_digest <<<"$running_identity"
  nyxdoc_info "Creating and verifying a backup before changing source or containers."
  if backup_output="$(nyxdoc_compose exec -T --user node app npm run backup:create -- --source-revision "$current_revision")"; then
    printf '%s\n' "$backup_output"
    backup_generation="$(printf '%s\n' "$backup_output" | sed -n 's/^[[:space:]]*"generationPath":[[:space:]]*"\([^"]*\)".*/\1/p' | tail -n 1)"
    backup_generation_id="$(printf '%s\n' "$backup_output" | sed -n 's/^[[:space:]]*"generationId":[[:space:]]*"\([^"]*\)".*/\1/p' | tail -n 1)"
    if [ -z "$backup_generation" ] || [ -z "$backup_generation_id" ]; then
      nyxdoc_die "The verified backup response did not include its generation identity."
    fi
    backup_source_revision="$(nyxdoc_backup_manifest_source_revision "$backup_generation_id")" \
      || nyxdoc_die "The verified backup manifest did not contain a valid sourceRevision."
    [ "$backup_source_revision" = "$current_revision" ] \
      || nyxdoc_die "The verified backup sourceRevision ($backup_source_revision) does not match the running checkout ($current_revision). Reconcile the deployment before updating."
    nyxdoc_write_update_state \
      "$current_revision" "$target_revision" "$target_label" \
      "$backup_generation_id" "$backup_generation" "$target_image" \
      "$update_authority" "$previous_configured_image" \
      "$previous_running_image_id" "$previous_running_image_digest" \
      "$backup_source_revision" \
      || nyxdoc_die "Could not persist the verified pre-update backup receipt."
  else
    printf '%s\n' "$backup_output" >&2
    nyxdoc_die "The app could not create the required verified pre-update backup."
  fi
else
  nyxdoc_die "The app is not running and no interrupted-update receipt exists."
fi

if ! $authority_was_explicit; then
  nyxdoc_info "Persisting NYXDOC_UPDATE_AUTHORITY=$update_authority for future deterministic updates."
fi
nyxdoc_env_set NYXDOC_UPDATE_AUTHORITY "$update_authority"

failed=true
on_exit() {
  if $failed; then
    printf '[nyxdoc] update failed. Previous source revision: %s\n' "$current_revision" >&2
    [ -z "$previous_configured_image" ] \
      || printf '[nyxdoc] previous configured image: %s\n' "$previous_configured_image" >&2
    [ -z "$previous_running_image_id" ] \
      || printf '[nyxdoc] previous running image ID: %s\n' "$previous_running_image_id" >&2
    [ -z "$backup_generation" ] \
      || printf '[nyxdoc] verified backup: %s\n' "$backup_generation" >&2
    printf '[nyxdoc] automatic database rollback was not attempted. See DEPLOYMENT.md.\n' >&2
  fi
}
trap on_exit EXIT

if $source_changed; then
  git -C "$NYXDOC_ROOT" checkout --detach "$target_revision"
fi
source_revision="$(nyxdoc_source_revision)"
current_image="$(nyxdoc_env_get NYXDOC_IMAGE)"

if $build_local || [[ "$current_image" == nyxdoc-app:* ]]; then
  image="$target_image"
  nyxdoc_info "Building $image at $source_revision."
  # Do not point .env.production at a candidate until its build succeeds.
  # A failed candidate must leave a known runnable image available for the
  # verified-backup check performed by the next update attempt.
  NYXDOC_IMAGE="$image" nyxdoc_compose config --quiet
  NYXDOC_IMAGE="$image" nyxdoc_compose build --build-arg "SOURCE_REVISION=$source_revision"
else
  image="$target_image"
  NYXDOC_IMAGE="$image" nyxdoc_compose config --quiet
  if ! $image_prepared; then
    nyxdoc_info "Pulling $image."
    NYXDOC_IMAGE="$image" nyxdoc_compose pull app collaboration gateway
    nyxdoc_verify_official_image_revision "$image" "$source_revision"
  else
    nyxdoc_info "Using the already verified local copy of $image."
  fi
fi

nyxdoc_env_set NYXDOC_IMAGE "$image"
nyxdoc_info "Stopping public and collaboration writers before the offline database migration."
nyxdoc_compose stop -t 20 gateway
nyxdoc_compose stop -t 20 collaboration
nyxdoc_compose stop -t 20 app
nyxdoc_run_offline_database_migrations
nyxdoc_compose up -d --no-build --remove-orphans
nyxdoc_wait_for_services
nyxdoc_compose ps
nyxdoc_clear_update_state
failed=false
trap - EXIT

nyxdoc_info "Updated $current_revision -> $source_revision using $image on channel $channel."
[ -z "$backup_generation" ] || nyxdoc_info "Pre-update verified backup: $backup_generation"
