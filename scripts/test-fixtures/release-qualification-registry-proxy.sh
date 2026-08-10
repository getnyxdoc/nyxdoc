#!/usr/bin/env bash

# Project the not-yet-promoted semver image onto the already-published
# immutable candidate digest during release qualification only. Every other
# Docker command is delegated unchanged to the real Docker CLI.

set -Eeuo pipefail

real_docker="${NYXDOC_RELEASE_QUALIFICATION_REAL_DOCKER:-}"
semver_image="${NYXDOC_RELEASE_QUALIFICATION_SEMVER_IMAGE:-}"
candidate_digest="${NYXDOC_RELEASE_QUALIFICATION_CANDIDATE_DIGEST:-}"

[ -n "$real_docker" ] && [ -x "$real_docker" ] \
  || { printf '[nyxdoc] qualification registry proxy requires an executable real Docker path.\n' >&2; exit 1; }
[[ "$semver_image" =~ ^ghcr\.io/getnyxdoc/nyxdoc:[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || { printf '[nyxdoc] qualification registry proxy received an invalid semver image.\n' >&2; exit 1; }
[[ "$candidate_digest" =~ ^sha256:[a-f0-9]{64}$ ]] \
  || { printf '[nyxdoc] qualification registry proxy received an invalid candidate digest.\n' >&2; exit 1; }

if [ "$#" -eq 4 ] \
  && [ "$1" = buildx ] \
  && [ "$2" = imagetools ] \
  && [ "$3" = inspect ] \
  && [ "$4" = "$semver_image" ]; then
  printf 'Name: %s\nDigest: %s\n' "$semver_image" "$candidate_digest"
  exit 0
fi

exec "$real_docker" "$@"
