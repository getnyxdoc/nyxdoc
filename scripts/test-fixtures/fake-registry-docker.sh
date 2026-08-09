#!/usr/bin/env bash

set -Eeuo pipefail

if [ "${1:-} ${2:-} ${3:-}" = "buildx imagetools inspect" ]; then
  reference="${4:-}"
  digest="$(awk -v ref="$reference" '$1 == ref { print $2; exit }' "$FAKE_REGISTRY_STATE" 2>/dev/null || true)"
  if [ -z "$digest" ]; then
    printf 'manifest unknown: %s\n' "$reference" >&2
    exit 1
  fi
  printf 'Digest: %s\n' "$digest"
  exit 0
fi

if [ "${1:-}" = pull ]; then
  exit 0
fi

if [ "${1:-} ${2:-}" = "image inspect" ]; then
  # The promotion contract validates both OCI provenance labels. Its fake
  # registry models those labels as the candidate revision supplied by the
  # test, regardless of which of the two label templates Docker receives.
  printf '%s\n' "${FAKE_CANDIDATE_REVISION:?}"
  exit 0
fi

if [ "${1:-} ${2:-} ${3:-}" = "buildx imagetools create" ]; then
  tag=""
  shift 3
  while [ "$#" -gt 0 ]; do
    if [ "$1" = -t ]; then
      tag="$2"
      shift 2
      continue
    fi
    shift
  done
  [ -n "$tag" ]
  printf 'create %s\n' "$tag" >>"$FAKE_DOCKER_LOG"
  printf '%s %s\n' "$tag" "$FAKE_CANDIDATE_DIGEST" >>"$FAKE_REGISTRY_STATE"
  exit 0
fi

exit 2
