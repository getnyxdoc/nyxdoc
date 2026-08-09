#!/usr/bin/env bash
# Shared helpers for the supported Linux + Docker Compose lifecycle scripts.

set -Eeuo pipefail

NYXDOC_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -L)"
NYXDOC_ENV_FILE="$NYXDOC_ROOT/.env.production"
NYXDOC_COMPOSE_FILE="$NYXDOC_ROOT/compose.yaml"

nyxdoc_info() {
  printf '[nyxdoc] %s\n' "$*"
}

nyxdoc_die() {
  printf '[nyxdoc] error: %s\n' "$*" >&2
  exit 1
}

nyxdoc_require_command() {
  command -v "$1" >/dev/null 2>&1 || nyxdoc_die "Required command not found: $1"
}

nyxdoc_require_compose() {
  nyxdoc_require_command docker
  docker compose version >/dev/null 2>&1 \
    || nyxdoc_die "Docker Compose v2 is required (docker compose)."
}

nyxdoc_require_buildx() {
  docker buildx version >/dev/null 2>&1 \
    || nyxdoc_die "Docker Buildx is required for verified stable image discovery (docker buildx)."
}

nyxdoc_require_environment() {
  [ -f "$NYXDOC_ENV_FILE" ] \
    || nyxdoc_die "Missing $NYXDOC_ENV_FILE. Run ./scripts/install.sh first."
}

nyxdoc_compose() {
  docker compose \
    --project-directory "$NYXDOC_ROOT" \
    --env-file "$NYXDOC_ENV_FILE" \
    -f "$NYXDOC_COMPOSE_FILE" \
    "$@"
}

nyxdoc_services_use_image() {
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

nyxdoc_env_get() {
  local key="$1"
  awk -v key="$key" '
    index($0, key "=") == 1 {
      sub("^[^=]*=", "")
      sub(/\r$/, "")
      print
      exit
    }
  ' "$NYXDOC_ENV_FILE"
}

nyxdoc_env_remove() {
  local key="$1"
  local temporary
  grep -q "^${key}=" "$NYXDOC_ENV_FILE" || return 1
  temporary="$(mktemp "$NYXDOC_ENV_FILE.tmp.XXXXXX")"
  awk -v key="$key" 'index($0, key "=") != 1 { print }' \
    "$NYXDOC_ENV_FILE" >"$temporary"
  chmod --reference="$NYXDOC_ENV_FILE" "$temporary" 2>/dev/null || chmod 600 "$temporary"
  mv -f "$temporary" "$NYXDOC_ENV_FILE"
}

nyxdoc_data_volume_name() {
  local data_volume
  data_volume="$(nyxdoc_env_get NYXDOC_DATA_VOLUME)"
  data_volume="${data_volume:-nyxdoc_data}"
  [[ "$data_volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
    || nyxdoc_die "NYXDOC_DATA_VOLUME is not a valid Docker volume name."
  printf '%s\n' "$data_volume"
}

nyxdoc_running_containers_using_data_volume() {
  local data_volume
  data_volume="$(nyxdoc_data_volume_name)"
  docker ps --filter "volume=$data_volume" --quiet
}

nyxdoc_require_data_volume_quiescent() {
  local data_volume running_containers
  data_volume="$(nyxdoc_data_volume_name)"
  running_containers="$(nyxdoc_running_containers_using_data_volume)" \
    || nyxdoc_die "Could not inspect running containers that use Docker volume $data_volume."
  [ -z "$running_containers" ] \
    || nyxdoc_die "Docker volume $data_volume is still used by a running container; refusing an offline database migration."
}

nyxdoc_run_offline_database_migrations() {
  local data_volume
  data_volume="$(nyxdoc_data_volume_name)"
  nyxdoc_require_data_volume_quiescent
  nyxdoc_info "Preparing data, media, and backup paths for the container user."
  # Run the image entrypoint as root once before switching to the unprivileged
  # migration process. This normalizes bind-mount ownership even when the host
  # installer account does not share Docker's node UID (1000).
  nyxdoc_compose run --rm --no-deps app true
  nyxdoc_info "Running database migrations in an isolated one-off container for volume $data_volume."
  # The high localhost port is deliberately unused inside this one-off
  # container. A connection refusal therefore gives the migration process a
  # mechanical proof that no collaboration writer can be active, while DNS or
  # other ambiguous network failures remain fail-closed.
  nyxdoc_compose run --rm --no-deps --user node \
    -e NYXDOC_COLLABORATION_INTERNAL_URL=http://127.0.0.1:65534 \
    app npm run db:migrate
}

nyxdoc_env_set() {
  local key="$1"
  local value="$2"
  local temporary
  temporary="$(mktemp "$NYXDOC_ENV_FILE.tmp.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    index($0, key "=") == 1 {
      print key "=" value
      replaced = 1
      next
    }
    { print }
    END {
      if (!replaced) print key "=" value
    }
  ' "$NYXDOC_ENV_FILE" >"$temporary"
  chmod --reference="$NYXDOC_ENV_FILE" "$temporary" 2>/dev/null || chmod 600 "$temporary"
  mv -f "$temporary" "$NYXDOC_ENV_FILE"
}

nyxdoc_generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -d '\n'
    return
  fi
  nyxdoc_require_command base64
  head -c 48 /dev/urandom | base64 | tr -d '\n'
}

nyxdoc_validate_environment() {
  local auth_secret collaboration_secret
  auth_secret="$(nyxdoc_env_get BETTER_AUTH_SECRET)"
  collaboration_secret="$(nyxdoc_env_get NYXDOC_COLLABORATION_SECRET)"

  [ "${#auth_secret}" -ge 32 ] \
    || nyxdoc_die "BETTER_AUTH_SECRET must contain at least 32 characters."
  [ "${#collaboration_secret}" -ge 32 ] \
    || nyxdoc_die "NYXDOC_COLLABORATION_SECRET must contain at least 32 characters."
  [ "$auth_secret" != "$collaboration_secret" ] \
    || nyxdoc_die "Authentication and collaboration secrets must be different."
  case "$auth_secret:$collaboration_secret" in
    *replace-with*) nyxdoc_die "Replace every placeholder secret in .env.production." ;;
  esac
}

nyxdoc_package_version() {
  local version
  version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$NYXDOC_ROOT/package.json" | head -n 1)"
  [ -n "$version" ] || nyxdoc_die "Could not read the Nyxdoc version from package.json."
  printf '%s\n' "$version"
}

nyxdoc_package_version_at_revision() {
  local revision="$1"
  local package_json version

  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] \
    || nyxdoc_die "Could not read the Nyxdoc version from an invalid target revision."
  package_json="$(git -C "$NYXDOC_ROOT" show "${revision}:package.json")" \
    || nyxdoc_die "Could not read package.json from target revision $revision."
  version="$(printf '%s\n' "$package_json" \
    | sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1)"
  [ -n "$version" ] \
    || nyxdoc_die "Could not read the Nyxdoc version from target revision $revision."
  printf '%s\n' "$version"
}

nyxdoc_select_update_image() {
  local current_image="${1:-}"
  local version="${2:-}"
  local override_image="${3:-}"

  [ -n "$version" ] || nyxdoc_die "An update version is required to select an image."

  if [ -n "$override_image" ]; then
    printf '%s\n' "$override_image"
    return
  fi

  case "$current_image" in
    ""|ghcr.io/getnyxdoc/nyxdoc:*|ghcr.io/getnyxdoc/nyxdoc@sha256:*)
      printf 'ghcr.io/getnyxdoc/nyxdoc:%s\n' "$version"
      ;;
    *)
      # Preserve explicitly configured third-party or locally mirrored images.
      printf '%s\n' "$current_image"
      ;;
  esac
}

nyxdoc_is_official_release_image() {
  case "${1:-}" in
    ghcr.io/getnyxdoc/nyxdoc:*|ghcr.io/getnyxdoc/nyxdoc@sha256:*) return 0 ;;
    *) return 1 ;;
  esac
}

nyxdoc_official_release_source() {
  local source="${NYXDOC_OFFICIAL_RELEASE_SOURCE:-https://github.com/getnyxdoc/nyxdoc.git}"

  if [ -z "$source" ] || [[ "$source" == -* ]] || [[ "$source" == *[[:space:]]* ]]; then
    nyxdoc_die "NYXDOC_OFFICIAL_RELEASE_SOURCE must be one explicit Git repository URL without whitespace."
  fi
  printf '%s\n' "$source"
}

nyxdoc_update_uses_official_release_source() {
  local current_image="${1:-}"
  local override_image="${2:-}"

  if [ -n "$override_image" ]; then
    nyxdoc_is_official_release_image "$override_image"
    return
  fi
  [ -z "$current_image" ] || nyxdoc_is_official_release_image "$current_image"
}

# Update authority is intentionally independent from the configured container
# image.  An operator can run a locally mirrored official image while keeping
# their checkout on a development fork, and an image tag is not consent to
# cross an unrelated Git history.  New installs persist this value in
# .env.production.  The image-based branch below exists only to migrate older
# installs which predate NYXDOC_UPDATE_AUTHORITY.
nyxdoc_update_authority() {
  local current_image="${1:-}"
  local override_image="${2:-}"
  local configured="${NYXDOC_UPDATE_AUTHORITY:-}"
  local persisted

  persisted="$(nyxdoc_env_get NYXDOC_UPDATE_AUTHORITY)"
  if [ -n "$configured" ] && [ -n "$persisted" ] && [ "$configured" != "$persisted" ]; then
    nyxdoc_die "NYXDOC_UPDATE_AUTHORITY from the environment does not match .env.production."
  fi
  configured="${configured:-$persisted}"

  if [ -z "$configured" ]; then
    if nyxdoc_update_uses_official_release_source "$current_image" "$override_image"; then
      printf 'official\n'
    else
      printf 'origin\n'
    fi
    return
  fi

  case "$configured" in
    official|origin) printf '%s\n' "$configured" ;;
    *) nyxdoc_die "NYXDOC_UPDATE_AUTHORITY must be official or origin." ;;
  esac
}

nyxdoc_update_authority_is_explicit() {
  [ -n "${NYXDOC_UPDATE_AUTHORITY:-}" ] || [ -n "$(nyxdoc_env_get NYXDOC_UPDATE_AUTHORITY)" ]
}

nyxdoc_capture_running_image_identity() {
  local service container_id image_id repository_digest observed_digest

  image_id=""
  for service in app collaboration gateway; do
    container_id="$(nyxdoc_compose ps --status running -q "$service")"
    [ -n "$container_id" ] || return 1
    observed_digest="$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null)" || return 1
    [[ "$observed_digest" =~ ^sha256:[A-Za-z0-9._-]+$ ]] || return 1
    if [ -z "$image_id" ]; then
      image_id="$observed_digest"
    elif [ "$image_id" != "$observed_digest" ]; then
      return 1
    fi
  done

  repository_digest="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id" 2>/dev/null \
    | awk '/@sha256:[a-f0-9]{64}$/ { print; exit }')" || return 1
  [ -n "$repository_digest" ] || repository_digest="unavailable"
  printf '%s\t%s\n' "$image_id" "$repository_digest"
}

nyxdoc_pin_official_release_image() {
  local image="$1"
  local inspection digest repository

  nyxdoc_is_official_release_image "$image" || {
    printf '%s\n' "$image"
    return
  }
  if [[ "$image" == *@sha256:* ]]; then
    [[ "$image" =~ ^ghcr\.io/getnyxdoc/nyxdoc@sha256:[a-f0-9]{64}$ ]] \
      || nyxdoc_die "The official release image contains an invalid digest: $image"
    printf '%s\n' "$image"
    return
  fi

  nyxdoc_require_buildx
  inspection="$(docker buildx imagetools inspect "$image" 2>&1)" \
    || nyxdoc_die "Could not resolve the official release image digest: $image"
  digest="$(printf '%s\n' "$inspection" | awk '$1 == "Digest:" { print $2; exit }')"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] \
    || nyxdoc_die "The official release image returned an invalid registry digest: $image"
  repository="${image%:*}"
  [ "$repository" = "ghcr.io/getnyxdoc/nyxdoc" ] \
    || nyxdoc_die "Could not derive the official image repository from $image."
  printf '%s@%s\n' "$repository" "$digest"
}

nyxdoc_compare_stable_versions() {
  local left="$1"
  local right="$2"
  local left_major left_minor left_patch right_major right_minor right_patch

  IFS=. read -r left_major left_minor left_patch <<<"$left"
  IFS=. read -r right_major right_minor right_patch <<<"$right"
  if ! [[ "$left_major" =~ ^[0-9]+$ && "$left_minor" =~ ^[0-9]+$ && "$left_patch" =~ ^[0-9]+$ ]] \
    || ! [[ "$right_major" =~ ^[0-9]+$ && "$right_minor" =~ ^[0-9]+$ && "$right_patch" =~ ^[0-9]+$ ]]; then
    nyxdoc_die "Stable update versions must use X.Y.Z."
  fi

  if ((10#$left_major != 10#$right_major)); then
    ((10#$left_major < 10#$right_major)) && printf '%s\n' -1 || printf '%s\n' 1
  elif ((10#$left_minor != 10#$right_minor)); then
    ((10#$left_minor < 10#$right_minor)) && printf '%s\n' -1 || printf '%s\n' 1
  elif ((10#$left_patch != 10#$right_patch)); then
    ((10#$left_patch < 10#$right_patch)) && printf '%s\n' -1 || printf '%s\n' 1
  else
    printf '%s\n' 0
  fi
}

nyxdoc_is_local_build_image() {
  case "${1:-}" in
    nyxdoc-app:*) return 0 ;;
    *) return 1 ;;
  esac
}

nyxdoc_require_explicit_image_for_source_advance() {
  local current_image="${1:-}"
  local override_image="${2:-}"

  # An official image is independently tied to the target source revision and
  # a nyxdoc-app:* reference is rebuilt by update.sh. Any other configured
  # image can be a private registry or mirror whose tag/digest does not encode
  # the target revision. Do not advance the checkout while silently keeping it.
  [ -n "$current_image" ] || return 0
  nyxdoc_is_official_release_image "$current_image" && return 0
  nyxdoc_is_local_build_image "$current_image" && return 0
  [ -n "$override_image" ] && return 0

  nyxdoc_die "NYXDOC_IMAGE is a non-official image ($current_image). Advancing source requires NYXDOC_UPDATE_IMAGE=<new image> or --build; the existing third-party image will not be reused automatically."
}

nyxdoc_verify_official_image_revision() {
  local image="$1"
  local expected_revision="$2"
  local oci_revision environment revision_count image_revision

  nyxdoc_is_official_release_image "$image" || return 0
  [[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]] \
    || nyxdoc_die "Cannot verify the official release image against an invalid target revision."

  oci_revision="$(docker image inspect --format \
    '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$image" 2>/dev/null)" \
    || nyxdoc_die "Could not inspect the official release image OCI revision: $image"
  [ "$oci_revision" = "$expected_revision" ] \
    || nyxdoc_die "Official release image OCI revision does not match target checkout $expected_revision: $image"

  environment="$(docker image inspect --format \
    '{{range .Config.Env}}{{println .}}{{end}}' \
    "$image" 2>/dev/null)" \
    || nyxdoc_die "Could not inspect the official release image environment: $image"
  revision_count="$(printf '%s\n' "$environment" | awk -F= \
    '$1 == "NYXDOC_SOURCE_REVISION" { count += 1 } END { print count + 0 }')"
  [ "$revision_count" = 1 ] \
    || nyxdoc_die "Official release image must contain exactly one NYXDOC_SOURCE_REVISION value: $image"
  image_revision="$(printf '%s\n' "$environment" | awk -F= \
    '$1 == "NYXDOC_SOURCE_REVISION" { print substr($0, index($0, "=") + 1); exit }')"
  [ "$image_revision" = "$expected_revision" ] \
    || nyxdoc_die "Official release image NYXDOC_SOURCE_REVISION does not match target checkout $expected_revision: $image"
}

nyxdoc_verify_image_source_revision() {
  local image="$1"
  local expected_revision="$2"
  local environment revision_count image_revision

  [[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]] \
    || nyxdoc_die "Cannot verify an image against an invalid source revision."
  environment="$(docker image inspect --format \
    '{{range .Config.Env}}{{println .}}{{end}}' \
    "$image" 2>/dev/null)" \
    || nyxdoc_die "Could not inspect the running Nyxdoc image environment: $image"
  revision_count="$(printf '%s\n' "$environment" | awk -F= \
    '$1 == "NYXDOC_SOURCE_REVISION" { count += 1 } END { print count + 0 }')"
  [ "$revision_count" = 1 ] \
    || nyxdoc_die "The running Nyxdoc image must contain exactly one NYXDOC_SOURCE_REVISION value: $image"
  image_revision="$(printf '%s\n' "$environment" | awk -F= \
    '$1 == "NYXDOC_SOURCE_REVISION" { print substr($0, index($0, "=") + 1); exit }')"
  [ "$image_revision" = "$expected_revision" ] \
    || nyxdoc_die "The running Nyxdoc image revision ($image_revision) does not match checkout $expected_revision."
}

nyxdoc_source_revision() {
  if command -v git >/dev/null 2>&1 && git -C "$NYXDOC_ROOT" rev-parse --verify HEAD >/dev/null 2>&1; then
    git -C "$NYXDOC_ROOT" rev-parse HEAD
  else
    printf 'v%s\n' "$(nyxdoc_package_version)"
  fi
}

nyxdoc_resolve_update_target() {
  local channel="$1"
  local source_kind="${2:-origin}"
  local source="origin"
  local source_label="origin"
  local remote_tag_ref=""
  local remote_tag_refs=""
  local candidate_ref version image inspection digest
  local mirror_ref="refs/nyxdoc-update/stable"

  case "$source_kind" in
    origin) ;;
    official)
      [ "$channel" = stable ] \
        || nyxdoc_die "The official release source is only valid for the stable channel."
      source="$(nyxdoc_official_release_source)"
      source_label="official release source"
      mirror_ref="refs/nyxdoc-update/official-stable"
      ;;
    *) nyxdoc_die "Unknown update source kind: $source_kind" ;;
  esac

  # Fetch branches without auto-following tags. A tag-triggered GitHub Actions
  # checkout can expose the current annotated release as a local lightweight
  # tag; a normal `fetch --tags` then aborts with "would clobber existing tag".
  # Resolve stable releases from origin into a private mirror ref instead, so
  # local/user tags are neither trusted nor rewritten by the updater.
  if [ "$source_kind" = origin ]; then
    git -C "$NYXDOC_ROOT" fetch --no-tags --prune origin \
      "+refs/heads/main:refs/remotes/origin/main"
  fi

  if [ "$channel" = stable ]; then
    remote_tag_refs="$(git -C "$NYXDOC_ROOT" ls-remote --exit-code --refs \
      --sort=-version:refname "$source" 'refs/tags/v[0-9]*')" \
      || nyxdoc_die "Could not query stable release tags from the $source_label."
    while IFS= read -r candidate_ref; do
      [ -n "$candidate_ref" ] || continue
      version="${candidate_ref#refs/tags/v}"
      image="ghcr.io/getnyxdoc/nyxdoc:${version}"
      inspection="$(docker buildx imagetools inspect "$image" 2>/dev/null || true)"
      digest="$(printf '%s\n' "$inspection" | awk '$1 == "Digest:" { print $2; exit }')"
      if [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
        remote_tag_ref="$candidate_ref"
        break
      fi
      printf '[nyxdoc] Skipping unqualified stable tag %s: no published semver image was verified.\n' \
        "${candidate_ref#refs/tags/}" >&2
    done < <(printf '%s\n' "$remote_tag_refs" \
      | awk '$2 ~ /^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+$/ { print $2 }')
    [ -n "$remote_tag_ref" ] \
      || nyxdoc_die "No stable Git tag with a verifiably published semver image was found on the $source_label."

    git -C "$NYXDOC_ROOT" update-ref -d "$mirror_ref" >/dev/null 2>&1 || true
    git -C "$NYXDOC_ROOT" fetch --no-tags "$source" \
      "${remote_tag_ref}:${mirror_ref}"
    printf '%s\t%s\n' "$mirror_ref" "${remote_tag_ref#refs/tags/}"
    return
  fi

  printf '%s\t%s\n' "origin/main" "origin/main"
}

nyxdoc_backup_host_path() {
  local configured
  configured="$(nyxdoc_env_get NYXDOC_BACKUP_HOST_PATH)"
  configured="${configured:-./data/backups}"
  case "$configured" in
    /*) printf '%s\n' "$configured" ;;
    *) printf '%s/%s\n' "$NYXDOC_ROOT" "${configured#./}" ;;
  esac
}

nyxdoc_update_state_file() {
  # The backup payload is written by the container's non-root runtime user,
  # so its host directory can legitimately be unavailable to the user who
  # runs lifecycle commands. Keep the resumable-update receipt with the
  # checkout instead: it is host control state, not backup data.
  printf '%s/.nyxdoc-update-state' "$NYXDOC_ROOT"
}

nyxdoc_update_state_get() {
  local state_file="$1"
  local key="$2"
  awk -v key="$key" '
    index($0, key "=") == 1 {
      sub("^[^=]*=", "")
      sub(/\r$/, "")
      print
      exit
    }
  ' "$state_file"
}

nyxdoc_backup_manifest_source_revision() {
  local generation_id="$1"
  local backup_root manifest_path generation_path source_revision

  [[ "$generation_id" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
  backup_root="$(nyxdoc_backup_host_path)"
  manifest_path="$backup_root/$generation_id/manifest.json"
  if [ -r "$manifest_path" ]; then
    source_revision="$(sed -n 's/^[[:space:]]*"sourceRevision"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest_path" | head -n 1)"
  else
    generation_path="/backups/$generation_id"
    source_revision="$(
      nyxdoc_compose run --rm --no-deps --user node app node -e '
        const fs = require("node:fs");
        const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (!/^[0-9a-f]{40}$/.test(manifest.sourceRevision ?? "")) process.exit(1);
        console.log(manifest.sourceRevision);
      ' "$generation_path/manifest.json" \
        | tr -d '\r' \
        | awk '$1 ~ /^[0-9a-f]+$/ && length($1) == 40 { value = $1 } END { print value }'
    )" || return 1
  fi
  [[ "$source_revision" =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s\n' "$source_revision"
}

nyxdoc_backup_manifest_sha256() {
  local generation_id="$1"
  local backup_root manifest_path generation_path manifest_sha256

  [[ "$generation_id" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
  backup_root="$(nyxdoc_backup_host_path)"
  manifest_path="$backup_root/$generation_id/manifest.json"
  if [ -r "$manifest_path" ]; then
    manifest_sha256="$(sha256sum -- "$manifest_path" | awk '{ print $1 }')" || return 1
  else
    generation_path="/backups/$generation_id"
    manifest_sha256="$(
      nyxdoc_compose run --rm --no-deps --user node app \
        sha256sum -- "$generation_path/manifest.json" \
        | tr -d '\r' \
        | awk '$1 ~ /^[a-f0-9]+$/ && length($1) == 64 { print $1; exit }'
    )" || return 1
  fi
  [[ "$manifest_sha256" =~ ^[a-f0-9]{64}$ ]] || return 1
  printf '%s\n' "$manifest_sha256"
}

nyxdoc_write_update_state() {
  local previous_revision="$1"
  local target_revision="$2"
  local target_label="$3"
  local generation_id="$4"
  local generation_path="$5"
  local target_image="${6:-}"
  local update_authority="${7:-}"
  local previous_configured_image="${8:-}"
  local previous_running_image_id="${9:-}"
  local previous_running_image_digest="${10:-}"
  local backup_source_revision="${11:-}"
  local manifest_sha256 state_file temporary format

  [[ "$previous_revision" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$target_revision" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$target_label" =~ ^[A-Za-z0-9._/-]+$ ]] || return 1
  [ -z "$target_image" ] || [[ "$target_image" != *[[:space:]]* ]] || return 1
  [[ "$generation_id" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
  [ "$generation_path" = "/backups/$generation_id" ] || return 1

  # Keep the v2 calling convention for interrupted updates created before
  # v0.25.18. New callers must provide the complete v3 recovery evidence.
  format="nyxdoc-update-state/v2"
  if [ -n "$update_authority$previous_configured_image$previous_running_image_id$previous_running_image_digest$backup_source_revision" ]; then
    [ -n "$update_authority" ] && [ -n "$previous_configured_image" ] \
      && [ -n "$previous_running_image_id" ] && [ -n "$previous_running_image_digest" ] \
      && [ -n "$backup_source_revision" ] || return 1
    case "$update_authority" in official|origin) ;; *) return 1 ;; esac
    [[ "$previous_configured_image" != *[[:space:]]* ]] || return 1
    [[ "$previous_running_image_id" =~ ^sha256:[A-Za-z0-9._-]+$ ]] || return 1
    [ "$previous_running_image_digest" = unavailable ] \
      || [[ "$previous_running_image_digest" =~ @sha256:[a-f0-9]{64}$ ]] || return 1
    [[ "$backup_source_revision" =~ ^[0-9a-f]{40}$ ]] || return 1
    [ "$backup_source_revision" = "$previous_revision" ] || return 1
    format="nyxdoc-update-state/v3"
  fi

  manifest_sha256="$(nyxdoc_backup_manifest_sha256 "$generation_id")" || return 1
  state_file="$(nyxdoc_update_state_file)"
  temporary="$(mktemp "${state_file}.tmp.XXXXXX")"
  {
    printf 'format=%s\n' "$format"
    printf 'previousRevision=%s\n' "$previous_revision"
    printf 'targetRevision=%s\n' "$target_revision"
    printf 'targetLabel=%s\n' "$target_label"
    [ -z "$target_image" ] || printf 'targetImage=%s\n' "$target_image"
    if [ "$format" = "nyxdoc-update-state/v3" ]; then
      printf 'updateAuthority=%s\n' "$update_authority"
      printf 'previousConfiguredImage=%s\n' "$previous_configured_image"
      printf 'previousRunningImageId=%s\n' "$previous_running_image_id"
      printf 'previousRunningImageDigest=%s\n' "$previous_running_image_digest"
      printf 'backupSourceRevision=%s\n' "$backup_source_revision"
    fi
    printf 'backupGenerationId=%s\n' "$generation_id"
    printf 'backupGenerationPath=%s\n' "$generation_path"
    printf 'backupManifestSha256=%s\n' "$manifest_sha256"
  } >"$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$state_file"
}

nyxdoc_resumable_update_target() {
  local current_revision="$1"
  local state_file format previous target target_label authority
  state_file="$(nyxdoc_update_state_file)"
  [ -f "$state_file" ] || return 1
  format="$(nyxdoc_update_state_get "$state_file" format)"
  previous="$(nyxdoc_update_state_get "$state_file" previousRevision)"
  target="$(nyxdoc_update_state_get "$state_file" targetRevision)"
  target_label="$(nyxdoc_update_state_get "$state_file" targetLabel)"
  [ "$format" = "nyxdoc-update-state/v2" ] || [ "$format" = "nyxdoc-update-state/v3" ] || return 1
  [[ "$previous" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$target" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$target_label" =~ ^[A-Za-z0-9._/-]+$ ]] || return 1
  [ "$current_revision" = "$previous" ] || [ "$current_revision" = "$target" ] || return 1
  [ "$(git -C "$NYXDOC_ROOT" rev-parse "${target}^{commit}" 2>/dev/null || true)" = "$target" ] \
    || return 1
  if [ "$format" = "nyxdoc-update-state/v3" ]; then
    authority="$(nyxdoc_update_state_get "$state_file" updateAuthority)"
    case "$authority" in official|origin) ;; *) return 1 ;; esac
  fi
  printf '%s\t%s\n' "$target" "$target_label"
}

nyxdoc_resumable_update_backup() {
  local current_revision="$1"
  local target_revision="$2"
  local state_file format previous stored_target generation_id generation_path stored_manifest_sha256
  local observed_manifest_sha256 stored_backup_source observed_backup_source
  state_file="$(nyxdoc_update_state_file)"
  [ -f "$state_file" ] || return 1
  format="$(nyxdoc_update_state_get "$state_file" format)"
  previous="$(nyxdoc_update_state_get "$state_file" previousRevision)"
  stored_target="$(nyxdoc_update_state_get "$state_file" targetRevision)"
  generation_id="$(nyxdoc_update_state_get "$state_file" backupGenerationId)"
  generation_path="$(nyxdoc_update_state_get "$state_file" backupGenerationPath)"
  stored_manifest_sha256="$(nyxdoc_update_state_get "$state_file" backupManifestSha256)"
  [ "$format" = "nyxdoc-update-state/v2" ] || [ "$format" = "nyxdoc-update-state/v3" ] || return 1
  [ "$stored_target" = "$target_revision" ] || return 1
  [ "$current_revision" = "$previous" ] || [ "$current_revision" = "$stored_target" ] || return 1
  [[ "$generation_id" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
  [ "$generation_path" = "/backups/$generation_id" ] || return 1
  [[ "$stored_manifest_sha256" =~ ^[a-f0-9]{64}$ ]] || return 1
  observed_manifest_sha256="$(nyxdoc_backup_manifest_sha256 "$generation_id")" || return 1
  [ "$observed_manifest_sha256" = "$stored_manifest_sha256" ] || return 1
  if [ "$format" = "nyxdoc-update-state/v3" ]; then
    stored_backup_source="$(nyxdoc_update_state_get "$state_file" backupSourceRevision)"
    [[ "$stored_backup_source" =~ ^[0-9a-f]{40}$ ]] || return 1
    [ "$stored_backup_source" = "$previous" ] || return 1
    observed_backup_source="$(nyxdoc_backup_manifest_source_revision "$generation_id")" || return 1
    [ "$observed_backup_source" = "$stored_backup_source" ] || return 1
  fi

  # A receipt only anchors the manifest. Re-run the application verifier so a
  # stopped, interrupted update cannot resume with a missing or altered
  # database/media payload whose manifest still happens to be intact.
  nyxdoc_compose run --rm --no-deps --user node app \
    npm run backup:verify -- "$generation_path" >/dev/null || return 1
  printf '%s\t%s\n' "$generation_id" "$generation_path"
}

nyxdoc_validate_resumable_update_context() {
  local current_revision="$1"
  local update_authority="$2"
  local current_image="$3"
  local state_file format previous target target_image receipt_authority previous_configured

  state_file="$(nyxdoc_update_state_file)"
  [ -f "$state_file" ] || return 1
  format="$(nyxdoc_update_state_get "$state_file" format)"
  [ "$format" = "nyxdoc-update-state/v2" ] && return 0
  [ "$format" = "nyxdoc-update-state/v3" ] || return 1

  previous="$(nyxdoc_update_state_get "$state_file" previousRevision)"
  target="$(nyxdoc_update_state_get "$state_file" targetRevision)"
  target_image="$(nyxdoc_update_state_get "$state_file" targetImage)"
  receipt_authority="$(nyxdoc_update_state_get "$state_file" updateAuthority)"
  previous_configured="$(nyxdoc_update_state_get "$state_file" previousConfiguredImage)"
  [[ "$previous" =~ ^[0-9a-f]{40}$ && "$target" =~ ^[0-9a-f]{40}$ ]] || return 1
  [ "$current_revision" = "$previous" ] || [ "$current_revision" = "$target" ] || return 1
  [ "$receipt_authority" = "$update_authority" ] || return 1
  [ -n "$previous_configured" ] || return 1
  # A failed attempt can have updated .env.production to the recorded target
  # before containers become healthy. Any third image is an out-of-band change
  # and must be diagnosed rather than overwritten during recovery.
  [ "$current_image" = "$previous_configured" ] || [ "$current_image" = "$target_image" ] || return 1
}

nyxdoc_clear_update_state() {
  rm -f "$(nyxdoc_update_state_file)"
}

nyxdoc_wait_for_url() {
  local label="$1"
  local url="$2"
  local attempts="${3:-60}"
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl --fail --silent --show-error --max-time 5 "$url" >/dev/null 2>&1; then
      nyxdoc_info "$label is healthy: $url"
      return 0
    fi
    sleep 2
  done
  nyxdoc_info "$label did not become healthy: $url"
  nyxdoc_compose ps || true
  nyxdoc_compose logs --tail 80 app collaboration gateway || true
  return 1
}

nyxdoc_wait_for_collaboration() {
  local attempts="$1"
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if nyxdoc_compose exec -T collaboration node -e '
      fetch("http://127.0.0.1:3101/health")
        .then((response) => process.exit(response.ok ? 0 : 1))
        .catch(() => process.exit(1));
    ' >/dev/null 2>&1; then
      nyxdoc_info "collaboration is healthy inside the Docker network"
      return 0
    fi
    sleep 2
  done
  nyxdoc_info "collaboration did not become healthy inside the Docker network"
  nyxdoc_compose ps || true
  nyxdoc_compose logs --tail 80 app collaboration gateway || true
  return 1
}

nyxdoc_wait_for_services() {
  local http_port
  nyxdoc_require_command curl
  http_port="$(nyxdoc_env_get NYXDOC_HTTP_PORT)"
  http_port="${http_port:-3191}"
  nyxdoc_wait_for_url "gateway" "http://127.0.0.1:${http_port}/api/health"
  nyxdoc_wait_for_collaboration 60
}
