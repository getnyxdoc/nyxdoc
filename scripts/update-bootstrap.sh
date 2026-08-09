#!/usr/bin/env bash

# Safe entry point for installations whose checked-in updater predates the
# collaboration backup barrier. It is intentionally standalone so an operator
# on v0.25.17 can run the copy from the target release without modifying the
# checkout before its normal fast-forward update.

set -Eeuo pipefail

checkout_root="${NYXDOC_UPDATE_ROOT:-}"
if [ -z "$checkout_root" ] \
  && [ -f "$PWD/scripts/compose-common.sh" ] \
  && [ -f "$PWD/scripts/update.sh" ] \
  && [ -f "$PWD/package.json" ] \
  && git -C "$PWD" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # Preserve the operator's logical checkout path. Installations commonly use
  # a stable symlink, and Docker Compose derives its project identity from that
  # path rather than from Git's physical top-level path.
  checkout_root="$PWD"
fi
if [ -z "$checkout_root" ]; then
  checkout_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi
[ -n "$checkout_root" ] || {
  printf '[nyxdoc] error: run this command from an installed Nyxdoc Git checkout.\n' >&2
  exit 1
}
checkout_root="$(cd -- "$checkout_root" && pwd -L)"
if [ ! -f "$checkout_root/scripts/compose-common.sh" ] \
  || [ ! -f "$checkout_root/scripts/update.sh" ] \
  || [ ! -f "$checkout_root/package.json" ]; then
  printf '[nyxdoc] error: %s is not a Nyxdoc installation checkout.\n' "$checkout_root" >&2
  exit 1
fi

# The bootstrap intentionally sources the updater from the operator-selected
# checkout after validating all required files above.
# shellcheck disable=SC1091
source "$checkout_root/scripts/compose-common.sh"
[ "$NYXDOC_ROOT" = "$checkout_root" ] || nyxdoc_die "The update checkout root is inconsistent."

version_relation_to_0_25_17() {
  local version="$1"
  local major minor patch
  IFS=. read -r major minor patch <<<"$version"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ && "$patch" =~ ^[0-9]+$ ]] \
    || nyxdoc_die "The installed version is not a stable X.Y.Z version: $version"
  if ((10#$major < 0)); then printf '%s\n' -1; return; fi
  if ((10#$major > 0)); then printf '%s\n' 1; return; fi
  if ((10#$minor < 25)); then printf '%s\n' -1; return; fi
  if ((10#$minor > 25)); then printf '%s\n' 1; return; fi
  if ((10#$patch < 17)); then printf '%s\n' -1; return; fi
  if ((10#$patch > 17)); then printf '%s\n' 1; return; fi
  printf '%s\n' 0
}

installed_version="$(nyxdoc_package_version)"
installed_relation="$(version_relation_to_0_25_17 "$installed_version")"
case "$installed_relation" in
  -1)
    nyxdoc_die "The standalone first-hop bridge supports exactly 0.25.17. Upgrade older installations to 0.25.17 before using this bridge."
    ;;
  0) ;;
  1)
    resume_image=""
    if [ -f "$checkout_root/.nyxdoc-update-state" ]; then
      resume_image="$(awk -F= '$1 == "targetImage" { print substr($0, index($0, "=") + 1); exit }' \
        "$checkout_root/.nyxdoc-update-state")"
      if [ -n "$resume_image" ]; then
        [[ "$resume_image" != *[[:space:]]* ]] \
          || nyxdoc_die "The interrupted-update receipt contains an invalid target image."
        exec env NYXDOC_UPDATE_IMAGE="$resume_image" "$checkout_root/scripts/update.sh" "$@"
      fi
    fi
    exec "$checkout_root/scripts/update.sh" "$@"
    ;;
  *) nyxdoc_die "Could not classify the installed Nyxdoc version: $installed_version" ;;
esac

nyxdoc_require_compose
nyxdoc_require_environment
nyxdoc_require_command git
nyxdoc_require_command sha256sum
nyxdoc_validate_environment
[ -n "$(nyxdoc_compose ps --status running -q app)" ] \
  || nyxdoc_die "The app service must be running before the legacy update bridge starts."

bridge_target_tag="v0.25.19"
bridge_target_version="${bridge_target_tag#v}"
bridge_target_ref="refs/nyxdoc-update/legacy-bridge-${bridge_target_tag}"
current_revision="$(git -C "$checkout_root" rev-parse HEAD)"

legacy_build_local=false
legacy_channel="stable"
legacy_arguments=("$@")
for ((argument_index = 0; argument_index < ${#legacy_arguments[@]}; argument_index += 1)); do
  case "${legacy_arguments[$argument_index]}" in
    --build) legacy_build_local=true ;;
    --channel)
      argument_index=$((argument_index + 1))
      [ "$argument_index" -lt "${#legacy_arguments[@]}" ] \
        || nyxdoc_die "--channel requires stable."
      legacy_channel="${legacy_arguments[$argument_index]}"
      ;;
  esac
done
[ "$legacy_channel" = "stable" ] \
  || nyxdoc_die "The v0.25.17 bridge is a pinned stable first hop; use --channel stable."

current_image="$(nyxdoc_env_get NYXDOC_IMAGE)"
update_image_override="${NYXDOC_UPDATE_IMAGE:-}"
handoff_image=""
receipt_handoff_image=""
if [ -f "$checkout_root/.nyxdoc-update-state" ]; then
  receipt_handoff_image="$(awk -F= '$1 == "targetImage" { print substr($0, index($0, "=") + 1); exit }' \
    "$checkout_root/.nyxdoc-update-state")"
  if [ -n "$receipt_handoff_image" ] && [[ "$receipt_handoff_image" == *[[:space:]]* ]]; then
    nyxdoc_die "The interrupted legacy first-hop receipt contains an invalid target image."
  fi
fi

bootstrap_is_official_image() {
  case "${1:-}" in
    ghcr.io/getnyxdoc/nyxdoc:*|ghcr.io/getnyxdoc/nyxdoc@sha256:*) return 0 ;;
    *) return 1 ;;
  esac
}

bootstrap_official_source() {
  local source="${NYXDOC_OFFICIAL_RELEASE_SOURCE:-https://github.com/getnyxdoc/nyxdoc.git}"
  if [ -z "$source" ] || [[ "$source" == -* ]] || [[ "$source" == *[[:space:]]* ]]; then
    nyxdoc_die "NYXDOC_OFFICIAL_RELEASE_SOURCE must be one explicit Git repository URL without whitespace."
  fi
  printf '%s\n' "$source"
}

bridge_source=origin
stream_image="${receipt_handoff_image:-${update_image_override:-$current_image}}"
if ! $legacy_build_local && { [ -z "$stream_image" ] || bootstrap_is_official_image "$stream_image"; }; then
  bridge_source="$(bootstrap_official_source)"
fi

git -C "$checkout_root" update-ref -d "$bridge_target_ref" >/dev/null 2>&1 || true
git -C "$checkout_root" fetch --no-tags "$bridge_source" \
  "+refs/tags/${bridge_target_tag}:${bridge_target_ref}"
target_revision="$(git -C "$checkout_root" rev-parse "${bridge_target_ref}^{commit}")"
if ! git -C "$checkout_root" merge-base --is-ancestor "$current_revision" "$target_revision"; then
  [ "$bridge_source" != origin ] \
    || nyxdoc_die "${bridge_target_tag} is not a fast-forward descendant of the installed revision."
  nyxdoc_info "Switching the unrelated v0.25.17 checkout to the canonical official ${bridge_target_tag} commit; origin remains unchanged."
fi

if [ -f "$checkout_root/.nyxdoc-update-state" ]; then
  receipt_format="$(awk -F= '$1 == "format" { print substr($0, index($0, "=") + 1); exit }' \
    "$checkout_root/.nyxdoc-update-state")"
  receipt_previous="$(awk -F= '$1 == "previousRevision" { print substr($0, index($0, "=") + 1); exit }' \
    "$checkout_root/.nyxdoc-update-state")"
  receipt_target="$(awk -F= '$1 == "targetRevision" { print substr($0, index($0, "=") + 1); exit }' \
    "$checkout_root/.nyxdoc-update-state")"
  if [ -n "$receipt_handoff_image" ]; then
    if [ "$receipt_format" != "nyxdoc-update-state/v2" ] \
      || [ "$receipt_previous" != "$current_revision" ] \
      || [ "$receipt_target" != "$target_revision" ] \
      || [[ "$receipt_handoff_image" == *[[:space:]]* ]]; then
      nyxdoc_die "The interrupted legacy first-hop receipt does not match this checkout and target."
    fi
  fi
fi
if $legacy_build_local || [[ "$current_image" == nyxdoc-app:* ]]; then
  target_image="nyxdoc-app:${bridge_target_version}"
else
  if [ -n "$receipt_handoff_image" ]; then
    target_image="$receipt_handoff_image"
  else
    target_image="$(nyxdoc_select_update_image \
      "$current_image" "$bridge_target_version" "$update_image_override")"
  fi
  if [[ "$target_image" == *@sha256:* ]]; then
    handoff_image="$target_image"
  else
    docker buildx version >/dev/null 2>&1 \
      || nyxdoc_die "Docker Buildx is required to pin the legacy first-hop image by digest."
    target_inspection="$(docker buildx imagetools inspect "$target_image" 2>&1)" \
      || nyxdoc_die "Could not resolve the pinned first-hop image digest: $target_image"
    target_digest="$(printf '%s\n' "$target_inspection" \
      | awk '$1 == "Digest:" { print $2; exit }')"
    [[ "$target_digest" =~ ^sha256:[a-f0-9]{64}$ ]] \
      || nyxdoc_die "The pinned first-hop image returned an invalid registry digest."
    target_repository="${target_image%:*}"
    if [ -z "$target_repository" ] || [ "$target_repository" = "$target_image" ]; then
      nyxdoc_die "Could not derive the first-hop image repository from $target_image."
    fi
    handoff_image="${target_repository}@${target_digest}"
  fi

  [[ "$handoff_image" =~ @sha256:[a-f0-9]{64}$ ]] \
    || nyxdoc_die "The legacy first-hop image must be pinned by digest."
  nyxdoc_info "Pulling the immutable first-hop image $handoff_image for provenance verification."
  docker pull "$handoff_image" >/dev/null
  image_label_revision="$(docker image inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$handoff_image" 2>/dev/null || true)"
  image_environment="$(docker image inspect \
    --format '{{range .Config.Env}}{{println .}}{{end}}' \
    "$handoff_image" 2>/dev/null || true)"
  image_env_revision_count="$(printf '%s\n' "$image_environment" \
    | awk -F= '$1 == "NYXDOC_SOURCE_REVISION" { count += 1 } END { print count + 0 }')"
  image_env_revision="$(printf '%s\n' "$image_environment" \
    | awk -F= '$1 == "NYXDOC_SOURCE_REVISION" { print substr($0, index($0, "=") + 1); exit }')"
  [ "$image_label_revision" = "$target_revision" ] \
    || nyxdoc_die "The pinned first-hop image OCI revision does not match ${bridge_target_tag}."
  [ "$image_env_revision_count" = 1 ] \
    || nyxdoc_die "The pinned first-hop image must contain exactly one runtime source revision."
  [ "$image_env_revision" = "$target_revision" ] \
    || nyxdoc_die "The pinned first-hop image runtime revision does not match ${bridge_target_tag}."
fi

handoff_started=false
bridge_finished=false
on_exit() {
  local status=$?
  if [ "$status" -ne 0 ] && ! $handoff_started \
    && [ "$(git -C "$checkout_root" rev-parse HEAD 2>/dev/null || true)" = "$current_revision" ]; then
    nyxdoc_info "The legacy bridge stopped before source hand-off; restoring the existing services."
    nyxdoc_compose up -d --no-build app collaboration gateway >/dev/null 2>&1 || true
  fi
  $bridge_finished || return "$status"
}
trap on_exit EXIT

legacy_connections() {
  nyxdoc_compose exec -T collaboration node -e '
    fetch("http://127.0.0.1:3101/health")
      .then(async (response) => {
        if (!response.ok) process.exit(1);
        const payload = await response.json();
        if (!Number.isSafeInteger(payload.connections) || payload.connections < 0) process.exit(1);
        console.log(payload.connections);
      })
      .catch(() => process.exit(1));
  ' 2>/dev/null | tr -d '\r' | tail -n 1
}

legacy_services_use_image() {
  local image="$1"
  local desired_image_id service container_id running_image_id
  desired_image_id="$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null)" \
    || return 1
  [ -n "$desired_image_id" ] || return 1
  for service in app collaboration gateway; do
    container_id="$(nyxdoc_compose ps --status running -q "$service")"
    [ -n "$container_id" ] || return 1
    running_image_id="$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null)" \
      || return 1
    [ "$running_image_id" = "$desired_image_id" ] || return 1
  done
}

wait_for_zero_legacy_connections() {
  local attempt connections
  for ((attempt = 1; attempt <= 80; attempt += 1)); do
    connections="$(legacy_connections || true)"
    if [ "$connections" = "0" ]; then return 0; fi
    sleep 0.25
  done
  return 1
}

write_legacy_update_receipt() {
  local generation_id="$1"
  local generation_path="$2"
  local manifest_sha256 state_file temporary exclude_file receipt_image
  [[ "$generation_id" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
  [ "$generation_path" = "/backups/$generation_id" ] || return 1
  # The application container owns the backup payload. The host account that
  # runs lifecycle commands may intentionally be unable to traverse that bind
  # mount, so anchor the receipt through the already-running trusted app.
  manifest_sha256="$(
    nyxdoc_compose exec -T --user node app \
      sha256sum -- "$generation_path/manifest.json" \
      | tr -d '\r' \
      | awk '$1 ~ /^[a-f0-9]+$/ && length($1) == 64 { print $1; exit }'
  )" || return 1
  [[ "$manifest_sha256" =~ ^[a-f0-9]{64}$ ]] || return 1
  receipt_image="${handoff_image:-$target_image}"
  [ -n "$receipt_image" ] && [[ "$receipt_image" != *[[:space:]]* ]] || return 1
  state_file="$checkout_root/.nyxdoc-update-state"
  temporary="$(mktemp "${state_file}.tmp.XXXXXX")"
  {
    printf 'format=nyxdoc-update-state/v2\n'
    printf 'previousRevision=%s\n' "$current_revision"
    printf 'targetRevision=%s\n' "$target_revision"
    printf 'targetLabel=%s\n' "$bridge_target_tag"
    printf 'targetImage=%s\n' "$receipt_image"
    printf 'backupGenerationId=%s\n' "$generation_id"
    printf 'backupGenerationPath=%s\n' "$generation_path"
    printf 'backupManifestSha256=%s\n' "$manifest_sha256"
  } >"$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$state_file"

  # The old updater rejects every untracked path. Keep this operational receipt
  # outside its dirty-tree calculation without modifying tracked source.
  exclude_file="$(git -C "$checkout_root" rev-parse --git-path info/exclude)"
  grep -Fxq '/.nyxdoc-update-state' "$exclude_file" 2>/dev/null \
    || printf '/.nyxdoc-update-state\n' >>"$exclude_file"
}

nyxdoc_info "Quiescing the legacy collaboration service before its pre-update backup."
# v0.25.17 writes every accepted onChange mutation synchronously. Stop the only
# public HTTP/WebSocket boundary, then require positive evidence that all
# proxied collaboration connections have disappeared before snapshotting.
nyxdoc_compose stop -t 20 gateway
[ -z "$(nyxdoc_compose ps --status running -q gateway)" ] \
  || nyxdoc_die "The legacy public gateway did not stop."
wait_for_zero_legacy_connections \
  || nyxdoc_die "Legacy collaboration connections did not drain after the public gateway stopped."
# Confirm the zero-connection boundary remains closed beyond the legacy
# 1.5-second store debounce. This is an additional stability check, not the
# durability mechanism: accepted edits were already written by onChange.
sleep 2
[ "$(legacy_connections || true)" = "0" ] \
  || nyxdoc_die "A legacy collaboration connection appeared after the gateway was closed."

nyxdoc_info "Creating the first-hop verified backup after the drained WebSocket boundary."
backup_output="$(nyxdoc_compose exec -T --user node app npm run backup:create)"
printf '%s\n' "$backup_output"
backup_generation="$(printf '%s\n' "$backup_output" \
  | sed -n 's/^[[:space:]]*"generationPath":[[:space:]]*"\([^"]*\)".*/\1/p' \
  | tail -n 1)"
backup_generation_id="$(printf '%s\n' "$backup_output" \
  | sed -n 's/^[[:space:]]*"generationId":[[:space:]]*"\([^"]*\)".*/\1/p' \
  | tail -n 1)"
if [ -z "$backup_generation" ] || [ -z "$backup_generation_id" ]; then
  nyxdoc_die "The legacy verified backup did not return its generation identity."
fi
nyxdoc_compose exec -T --user node app npm run backup:verify -- "$backup_generation" >/dev/null
write_legacy_update_receipt "$backup_generation_id" "$backup_generation" \
  || nyxdoc_die "Could not persist the verified legacy first-hop backup receipt."
nyxdoc_info "Legacy bridge verified backup: $backup_generation"

# With the durable snapshot and receipt fixed, collaboration can stop without
# making the backup depend on its incomplete v0.25.17 shutdown implementation.
nyxdoc_compose stop -t 20 collaboration

[ -z "$(nyxdoc_compose ps --status running -q gateway collaboration)" ] \
  || nyxdoc_die "The legacy collaboration boundary did not become quiescent."

nyxdoc_info "Legacy collaboration is quiescent; checking out the exact target and resuming with its updater."
git -C "$checkout_root" checkout --detach "$target_revision"
handoff_started=true
NYXDOC_LEGACY_UPDATE_QUIESCED=1 \
NYXDOC_UPDATE_IMAGE="${handoff_image:-$target_image}" \
  "$checkout_root/scripts/update.sh" "$@"
[ "$(git -C "$checkout_root" rev-parse HEAD)" = "$target_revision" ] \
  || nyxdoc_die "The legacy updater did not stop at the pinned ${bridge_target_tag} first hop."
if ! $legacy_build_local; then
  [ "$(nyxdoc_env_get NYXDOC_IMAGE)" = "$handoff_image" ] \
    || nyxdoc_die "The legacy updater did not retain the immutable first-hop image reference."
  legacy_services_use_image "$handoff_image" \
    || nyxdoc_die "The legacy updater did not start every service from the immutable first-hop image."
fi
rm -f "$checkout_root/.nyxdoc-update-state"
bridge_finished=true
