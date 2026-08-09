#!/usr/bin/env bash

set -Eeuo pipefail

state="${FAKE_LIFECYCLE_STATE:?}"
root="${FAKE_LIFECYCLE_ROOT:?}"

image_id() {
  if [ "$1" = "ghcr.io/getnyxdoc/nyxdoc@sha256:$(printf '%064d' 1)" ]; then
    printf 'sha256:baseline\n'
    return
  fi
  if [ "$1" = "ghcr.io/getnyxdoc/nyxdoc@sha256:$(printf '%064d' 2)" ]; then
    printf 'sha256:candidate\n'
    return
  fi
  case "$1" in
    *:0.25.1) printf 'sha256:baseline\n' ;;
    *:0.25.2) printf 'sha256:candidate\n' ;;
    *) printf 'sha256:custom\n' ;;
  esac
}

image_digest() {
  case "$1" in
    *:0.25.1) printf 'sha256:%064d\n' 1 ;;
    *) printf 'sha256:%064d\n' 2 ;;
  esac
}

if [ "${1:-} ${2:-}" = "buildx version" ]; then
  printf 'github.com/docker/buildx fake\n'
  exit 0
fi

if [ "${1:-} ${2:-} ${3:-}" = "buildx imagetools inspect" ]; then
  reference="${4:-}"
  printf 'Name: %s\nDigest: %s\n' "$reference" "$(image_digest "$reference")"
  exit 0
fi

if [ "${1:-}" = image ] && [ "${2:-}" = inspect ]; then
  if printf '%s\n' "$@" | grep -q 'Config.Labels'; then
    printf '%s\n' "${FAKE_LIFECYCLE_SOURCE_REVISION:?}"
    exit 0
  fi
  if printf '%s\n' "$@" | grep -q 'Config.Env'; then
    printf 'NODE_ENV=production\n'
    if [ "${FAKE_LIFECYCLE_DUPLICATE_SOURCE_REVISION:-0}" = 1 ]; then
      printf 'NYXDOC_SOURCE_REVISION=%040d\n' 0
    fi
    printf 'NYXDOC_SOURCE_REVISION=%s\n' "${FAKE_LIFECYCLE_SOURCE_REVISION:?}"
    exit 0
  fi
  image_id "${@: -1}"
  exit 0
fi

if [ "${1:-}" = inspect ]; then
  cat "$state/image-id"
  exit 0
fi

if [ "${1:-}" = ps ]; then
  if [ "${FAKE_LIFECYCLE_FOREIGN_VOLUME_USER:-0}" = 1 ]; then
    printf 'foreign-data-volume-container\n'
  elif [ "$(cat "$state/running")" = 1 ]; then
    printf 'fake-data-volume-container\n'
  fi
  exit 0
fi

[ "${1:-}" = compose ] || exit 2
shift
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-directory|--env-file|-f) shift 2 ;;
    *) break ;;
  esac
done

command="${1:-}"
shift || true
case "$command" in
  version|config|build|logs)
    exit 0
    ;;
  pull)
    if [ -f "$state/fail-next-pull" ]; then
      rm "$state/fail-next-pull"
      exit 1
    fi
    exit 0
    ;;
  exec)
    # Lifecycle health checks execute a small Node probe in the collaboration
    # container. Only backup:create produces a generation; treating every
    # compose exec as a backup masks accidental extra backups in update tests.
    if ! printf '%s\n' "$*" | grep -Fq 'npm run backup:create'; then
      exit 0
    fi
    count="$(cat "$state/backup-count")"
    count="$((count + 1))"
    printf '%s\n' "$count" >"$state/backup-count"
    generation="generation-$count"
    mkdir -p "$root/data/backups/$generation"
    source_revision="$(git -C "$root" rev-parse HEAD)"
    printf '{\n  "format": "nyxdoc-backup/v2",\n  "sourceRevision": "%s"\n}\n' \
      "$source_revision" >"$root/data/backups/$generation/manifest.json"
    printf '{\n  "status": "verified",\n  "generationId": "%s",\n  "generationPath": "/backups/%s"\n}\n' \
      "$generation" "$generation"
    exit 0
    ;;
  run)
    if printf '%s\n' "$*" | grep -Fq 'app true'; then
      printf 'prepare-runtime-paths\n' >>"$state/log"
      exit 0
    fi
    if printf '%s\n' "$*" | grep -Fq 'npm run db:migrate'; then
      printf 'migrate\n' >>"$state/log"
      if [ -f "$state/fail-next-migrate" ]; then
        rm "$state/fail-next-migrate"
        printf 'migrate-failed\n' >>"$state/log"
        exit 1
      fi
      exit 0
    fi
    exit 2
    ;;
  stop)
    printf 'stop %s\n' "$*" >>"$state/log"
    printf '0\n' >"$state/running"
    exit 0
    ;;
  up)
    printf 'up %s\n' "$*" >>"$state/log"
    if [ -f "$state/fail-next-up" ]; then
      rm "$state/fail-next-up"
      printf '0\n' >"$state/running"
      printf 'up-failed\n' >>"$state/log"
      exit 1
    fi
    image="$(awk -F= '$1 == "NYXDOC_IMAGE" { print substr($0, index($0, "=") + 1); exit }' "$root/.env.production")"
    image_id "$image" >"$state/image-id"
    printf '1\n' >"$state/running"
    printf 'up-succeeded\n' >>"$state/log"
    exit 0
    ;;
  ps)
    if printf '%s\n' "$*" | grep -q -- '--status running'; then
      if [ "${FAKE_LIFECYCLE_FOREIGN_VOLUME_USER:-0}" != 1 ] \
        && [ "$(cat "$state/running")" = 1 ]; then
        printf '%s-id\n' "${@: -1}"
      fi
    else
      printf 'fake compose status\n'
    fi
    exit 0
    ;;
  down)
    printf 'down %s\n' "$*" >>"$state/log"
    printf '0\n' >"$state/running"
    exit 0
    ;;
esac

exit 2
