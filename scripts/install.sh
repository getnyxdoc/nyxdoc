#!/usr/bin/env bash

set -Eeuo pipefail
# shellcheck source-path=SCRIPTDIR
# shellcheck source=compose-common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/compose-common.sh"

usage() {
  cat <<'EOF'
Usage: ./scripts/install.sh [--build]

Install the current Nyxdoc release with Docker Compose.
  default   pull the versioned image from ghcr.io/getnyxdoc/nyxdoc
  --build   build the image from this checkout instead
EOF
}

build_local=false
for argument in "$@"; do
  case "$argument" in
    --build) build_local=true ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; nyxdoc_die "Unknown argument: $argument" ;;
  esac
done

nyxdoc_require_compose
nyxdoc_require_command awk
nyxdoc_require_command sed
nyxdoc_require_command curl

if [ ! -f "$NYXDOC_ENV_FILE" ]; then
  cp "$NYXDOC_ROOT/.env.production.example" "$NYXDOC_ENV_FILE"
  chmod 600 "$NYXDOC_ENV_FILE"
  nyxdoc_info "Created .env.production from the public example."
fi

auth_secret="$(nyxdoc_env_get BETTER_AUTH_SECRET)"
if [ "${#auth_secret}" -lt 32 ] || [[ "$auth_secret" == *replace-with* ]]; then
  nyxdoc_env_set BETTER_AUTH_SECRET "$(nyxdoc_generate_secret)"
  nyxdoc_info "Generated BETTER_AUTH_SECRET without displaying it."
fi

collaboration_secret="$(nyxdoc_env_get NYXDOC_COLLABORATION_SECRET)"
if [ "${#collaboration_secret}" -lt 32 ] || [[ "$collaboration_secret" == *replace-with* ]]; then
  next_secret="$(nyxdoc_generate_secret)"
  while [ "$next_secret" = "$(nyxdoc_env_get BETTER_AUTH_SECRET)" ]; do
    next_secret="$(nyxdoc_generate_secret)"
  done
  nyxdoc_env_set NYXDOC_COLLABORATION_SECRET "$next_secret"
  nyxdoc_info "Generated NYXDOC_COLLABORATION_SECRET without displaying it."
fi

chmod 600 "$NYXDOC_ENV_FILE"
nyxdoc_validate_environment
if nyxdoc_env_remove NYXDOC_SOURCE_REVISION; then
  nyxdoc_info "Removed legacy NYXDOC_SOURCE_REVISION override; image provenance is authoritative."
fi
mkdir -p "$(nyxdoc_backup_host_path)"

# Existing installations from before v0.25.18 did not record which Git
# lineage they intended to follow. Preserve their established behavior once,
# then persist it so future updates never infer authority from an image alone.
configured_image="$(nyxdoc_env_get NYXDOC_IMAGE)"
authority="$(nyxdoc_update_authority "$configured_image" "")"
if ! nyxdoc_update_authority_is_explicit; then
  nyxdoc_env_set NYXDOC_UPDATE_AUTHORITY "$authority"
  nyxdoc_info "Persisted NYXDOC_UPDATE_AUTHORITY=$authority for deterministic updates."
fi

version="$(nyxdoc_package_version)"
source_revision="$(nyxdoc_source_revision)"
if $build_local; then
  image="nyxdoc-app:${version}"
  nyxdoc_env_set NYXDOC_IMAGE "$image"
  nyxdoc_info "Building $image from source revision $source_revision."
  nyxdoc_compose config --quiet
  nyxdoc_compose build --build-arg "SOURCE_REVISION=$source_revision"
else
  configured_image="$(nyxdoc_env_get NYXDOC_IMAGE)"
  image="$configured_image"
  case "$configured_image" in
    ""|nyxdoc-app:*|ghcr.io/getnyxdoc/nyxdoc:*)
      image="ghcr.io/getnyxdoc/nyxdoc:${version}"
      ;;
  esac

  if nyxdoc_is_official_release_image "$image"; then
    [[ "$source_revision" =~ ^[0-9a-f]{40}$ ]] \
      || nyxdoc_die "Verified official image installation requires a Git checkout at the release revision."
    image="$(nyxdoc_pin_official_release_image "$image")"
    nyxdoc_info "Pulling verified official image $image."
    NYXDOC_IMAGE="$image" nyxdoc_compose config --quiet
    NYXDOC_IMAGE="$image" nyxdoc_compose pull app collaboration gateway
    nyxdoc_verify_official_image_revision "$image" "$source_revision"
    # Persist only the immutable, provenance-verified digest. A failed pull or
    # verification must never replace a previously known-good image setting.
    nyxdoc_env_set NYXDOC_IMAGE "$image"
  else
    nyxdoc_info "Pulling $image."
    NYXDOC_IMAGE="$image" nyxdoc_compose config --quiet
    NYXDOC_IMAGE="$image" nyxdoc_compose pull app collaboration gateway
  fi
fi

running_data_containers="$(nyxdoc_running_containers_using_data_volume)"
if [ -n "$running_data_containers" ]; then
  nyxdoc_services_use_image "$image" \
    || nyxdoc_die "The Nyxdoc data volume is in use by different or incomplete services. Use ./scripts/update.sh for upgrades, or stop the conflicting containers first."
  nyxdoc_info "The selected image is already running; no offline database migration is required."
else
  nyxdoc_run_offline_database_migrations
fi

nyxdoc_compose up -d --no-build --remove-orphans
nyxdoc_wait_for_services
nyxdoc_clear_update_state
nyxdoc_compose ps

http_port="$(nyxdoc_env_get NYXDOC_HTTP_PORT)"
http_port="${http_port:-3191}"
data_volume="$(nyxdoc_data_volume_name)"
nyxdoc_info "Installation complete. Open http://localhost:${http_port}"
nyxdoc_info "Data and media use the Docker volume $data_volume."
nyxdoc_info "Verified backups are stored at $(nyxdoc_backup_host_path)."
