#!/usr/bin/env bash
# Shared helpers for the supported Linux + Docker Compose lifecycle scripts.

set -Eeuo pipefail

NYXDOC_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
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

nyxdoc_source_revision() {
  if command -v git >/dev/null 2>&1 && git -C "$NYXDOC_ROOT" rev-parse --verify HEAD >/dev/null 2>&1; then
    git -C "$NYXDOC_ROOT" rev-parse HEAD
  else
    printf 'v%s\n' "$(nyxdoc_package_version)"
  fi
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

nyxdoc_wait_for_services() {
  local http_port collaboration_port
  nyxdoc_require_command curl
  http_port="$(nyxdoc_env_get NYXDOC_HTTP_PORT)"
  collaboration_port="$(nyxdoc_env_get NYXDOC_COLLABORATION_HOST_PORT)"
  http_port="${http_port:-3191}"
  collaboration_port="${collaboration_port:-3192}"
  nyxdoc_wait_for_url "gateway" "http://127.0.0.1:${http_port}/api/health"
  nyxdoc_wait_for_url "collaboration" "http://127.0.0.1:${collaboration_port}/health"
}
