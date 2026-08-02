#!/usr/bin/env bash

set -Eeuo pipefail
# shellcheck source-path=SCRIPTDIR
# shellcheck source=compose-common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/compose-common.sh"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/uninstall.sh
  ./scripts/uninstall.sh --purge --confirm-purge=nyxdoc

The default command stops and removes containers and the Compose network while
preserving the data volume, media, verified backups, source, and environment.
The purge form also removes the Compose data volume and locally built images.
External backup paths and .env.production are always preserved.
EOF
}

purge=false
confirmed=false
for argument in "$@"; do
  case "$argument" in
    --purge) purge=true ;;
    --confirm-purge=nyxdoc) confirmed=true ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; nyxdoc_die "Unknown argument: $argument" ;;
  esac
done

nyxdoc_require_compose
nyxdoc_require_environment
nyxdoc_validate_environment

image="$(nyxdoc_env_get NYXDOC_IMAGE)"
data_volume="$(nyxdoc_env_get NYXDOC_DATA_VOLUME)"
data_volume="${data_volume:-nyxdoc_data}"
backup_path="$(nyxdoc_backup_host_path)"

if ! $purge; then
  nyxdoc_info "Removing containers and the Compose network."
  nyxdoc_compose down --remove-orphans
  nyxdoc_info "Preserved data volume: $data_volume"
  nyxdoc_info "Preserved verified backups: $backup_path"
  nyxdoc_info "Preserved environment: $NYXDOC_ENV_FILE"
  nyxdoc_info "Run ./scripts/install.sh to start this installation again."
  exit 0
fi

$confirmed || nyxdoc_die "Permanent data removal requires --confirm-purge=nyxdoc."

nyxdoc_info "Permanent purge requested."
nyxdoc_info "Will remove Compose containers, network, data volume $data_volume, and locally built images."
nyxdoc_info "Will preserve source, $NYXDOC_ENV_FILE, and external backups at $backup_path."

if [ -n "$(nyxdoc_compose ps --status running -q app)" ]; then
  nyxdoc_info "Creating and verifying a final backup before removing the data volume."
  nyxdoc_compose exec -T --user node app npm run backup:create
else
  nyxdoc_info "The app is not running; no new backup can be created. Existing external backups remain preserved."
fi

nyxdoc_compose down --volumes --remove-orphans --rmi local
nyxdoc_info "Permanent purge complete."
nyxdoc_info "Preserved external backups: $backup_path"
nyxdoc_info "Preserved environment: $NYXDOC_ENV_FILE"
nyxdoc_info "Preserved source directory: $NYXDOC_ROOT"
[ -z "$image" ] || nyxdoc_info "A pulled registry image may remain in Docker's cache: $image"
