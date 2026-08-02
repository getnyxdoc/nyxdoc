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
mkdir -p "$(nyxdoc_backup_host_path)"

version="$(nyxdoc_package_version)"
source_revision="$(nyxdoc_source_revision)"
if $build_local; then
  image="nyxdoc-app:${version}"
  nyxdoc_env_set NYXDOC_IMAGE "$image"
  nyxdoc_info "Building $image from source revision $source_revision."
  nyxdoc_compose config --quiet
  nyxdoc_compose build --build-arg "SOURCE_REVISION=$source_revision"
else
  image="$(nyxdoc_env_get NYXDOC_IMAGE)"
  case "$image" in
    ""|nyxdoc-app:*|ghcr.io/getnyxdoc/nyxdoc:*)
      image="ghcr.io/getnyxdoc/nyxdoc:${version}"
      nyxdoc_env_set NYXDOC_IMAGE "$image"
      ;;
  esac
  nyxdoc_info "Pulling $image."
  nyxdoc_compose config --quiet
  nyxdoc_compose pull app collaboration gateway
fi

nyxdoc_compose up -d --no-build --remove-orphans
nyxdoc_wait_for_services
nyxdoc_compose ps

http_port="$(nyxdoc_env_get NYXDOC_HTTP_PORT)"
http_port="${http_port:-3191}"
data_volume="$(nyxdoc_env_get NYXDOC_DATA_VOLUME)"
data_volume="${data_volume:-nyxdoc_data}"
nyxdoc_info "Installation complete. Open http://localhost:${http_port}"
nyxdoc_info "Data and media use the Docker volume $data_volume."
nyxdoc_info "Verified backups are stored at $(nyxdoc_backup_host_path)."
