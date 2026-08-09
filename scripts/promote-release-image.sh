#!/usr/bin/env bash

# Publish a qualified immutable candidate digest in one explicit phase.
# `immutable` establishes and verifies the exact semver image before a public
# Git tag exists. `aliases` requires that exact image and the matching Git tag
# before any mutable alias is touched.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

candidate_image="${CANDIDATE_IMAGE:-}"
candidate_digest="${CANDIDATE_DIGEST:-}"
candidate_revision="${CANDIDATE_REVISION:-}"
version_tag="${VERSION_TAG:-}"
target_tags="${TARGET_TAGS:-}"
promotion_phase="${PROMOTION_PHASE:-}"

[ -n "$candidate_image" ] || { printf 'CANDIDATE_IMAGE is required\n' >&2; exit 1; }
[[ "$candidate_image" == *@sha256:* ]] \
  || { printf 'candidate image must be pinned by digest\n' >&2; exit 1; }
[[ "$candidate_digest" =~ ^sha256:[a-f0-9]{64}$ ]] \
  || { printf 'CANDIDATE_DIGEST is malformed\n' >&2; exit 1; }
[[ "$candidate_revision" =~ ^[0-9a-f]{40}$ ]] \
  || { printf 'CANDIDATE_REVISION must be a 40-character lowercase Git SHA\n' >&2; exit 1; }
[ "${candidate_image##*@}" = "$candidate_digest" ] \
  || { printf 'candidate image and digest disagree\n' >&2; exit 1; }
[[ "$version_tag" =~ ^[^[:space:]]+:[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || { printf 'VERSION_TAG must be an exact registry vX.Y.Z image tag\n' >&2; exit 1; }
[ -n "$target_tags" ] || { printf 'TARGET_TAGS is empty\n' >&2; exit 1; }
case "$promotion_phase" in
  immutable|aliases) ;;
  *) printf 'PROMOTION_PHASE must be immutable or aliases\n' >&2; exit 1 ;;
esac

candidate_repository="${candidate_image%@sha256:*}"
version_repository="${version_tag%:*}"
[ "$candidate_repository" = "$version_repository" ] \
  || { printf 'candidate image and release tags must use the same repository\n' >&2; exit 1; }

version_tag_present=false
for tag in $target_tags; do
  [[ "$tag" == "$version_repository:"* && "$tag" != *"@"* ]] \
    || { printf 'target tag %s is outside release repository %s\n' "$tag" "$version_repository" >&2; exit 1; }
  if [ "$tag" = "$version_tag" ]; then
    version_tag_present=true
  fi
done
$version_tag_present \
  || { printf 'TARGET_TAGS must include the exact immutable release tag %s\n' "$version_tag" >&2; exit 1; }

inspect_digest() {
  local reference="$1"
  local inspection
  inspection="$(docker buildx imagetools inspect "$reference" 2>&1)" || return 1
  printf '%s\n' "$inspection" | awk '$1 == "Digest:" { print $2; exit }'
}

registry_inspection_digest=""
is_unambiguous_manifest_absence() {
  # Registries use many human-readable errors.  In particular, a generic
  # "not found" can mean a missing credential helper, an access-hidden
  # repository, or a broken transport.  Promotion must fail closed unless the
  # registry explicitly identifies the missing *manifest*.
  local inspection="$1"

  grep -qiE \
    '(^|[^[:alnum:]_])(manifest unknown|no such manifest)([^[:alnum:]_]|$)' \
    <<<"$inspection"
}

inspect_existing_registry_reference() {
  # Return 0 only for an existing reference with a valid digest, 3 only for an
  # explicit registry not-found response, and fail closed for every ambiguous
  # transport/authentication/tool/parsing failure.
  local reference="$1"
  local inspection=""
  local inspect_status=0

  registry_inspection_digest=""
  inspection="$(docker buildx imagetools inspect "$reference" 2>&1)" || inspect_status=$?
  if [ "$inspect_status" -ne 0 ]; then
    if [ -n "$inspection" ] && is_unambiguous_manifest_absence "$inspection"; then
      return 3
    fi
    printf 'refusing registry publication: inspection of %s failed: %s\n' \
      "$reference" "${inspection:-no diagnostic output}" >&2
    return 1
  fi

  registry_inspection_digest="$(printf '%s\n' "$inspection" | awk '$1 == "Digest:" { print $2; exit }')"
  if [[ ! "$registry_inspection_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    printf 'refusing registry publication: inspection of %s returned a corrupt digest %s\n' \
      "$reference" "${registry_inspection_digest:-missing}" >&2
    return 1
  fi
}

verify_candidate_provenance() {
  local observed_digest=""
  local oci_revision=""
  local source_revision=""

  observed_digest="$(inspect_digest "$candidate_image" || true)"
  [ "$observed_digest" = "$candidate_digest" ] \
    || { printf 'candidate registry digest %s differs from %s\n' \
      "${observed_digest:-missing}" "$candidate_digest" >&2; return 1; }

  docker pull "$candidate_image" >/dev/null
  oci_revision="$(docker image inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$candidate_image" 2>/dev/null || true)"
  [ "$oci_revision" = "$candidate_revision" ] \
    || { printf 'candidate image OCI revision label %s differs from %s\n' \
      "${oci_revision:-missing}" "$candidate_revision" >&2; return 1; }

  source_revision="$(docker image inspect \
    --format '{{ range .Config.Env }}{{ println . }}{{ end }}' \
    "$candidate_image" 2>/dev/null \
    | sed -n 's/^NYXDOC_SOURCE_REVISION=//p' \
    | tail -n 1 || true)"
  [ "$source_revision" = "$candidate_revision" ] \
    || { printf 'candidate image NYXDOC_SOURCE_REVISION environment %s differs from %s\n' \
      "${source_revision:-missing}" "$candidate_revision" >&2; return 1; }
}

verify_candidate_provenance

release_version="${version_tag##*:}"

semver_compare() {
  # Prints -1, 0, or 1 when the first stable X.Y.Z version is respectively
  # lower than, equal to, or greater than the second one.
  local left="$1"
  local right="$2"
  local -a left_parts right_parts

  IFS=. read -r -a left_parts <<<"$left"
  IFS=. read -r -a right_parts <<<"$right"
  [ "${#left_parts[@]}" -eq 3 ] && [ "${#right_parts[@]}" -eq 3 ] || return 1
  for component in "${left_parts[@]}" "${right_parts[@]}"; do
    [[ "$component" =~ ^[0-9]+$ ]] || return 1
  done

  for index in 0 1 2; do
    local left_value right_value
    left_value="${left_parts[$index]}"
    right_value="${right_parts[$index]}"
    if ((10#$left_value < 10#$right_value)); then
      printf '%s\n' -1
      return
    fi
    if ((10#$left_value > 10#$right_value)); then
      printf '%s\n' 1
      return
    fi
  done
  printf '%s\n' 0
}

version_for_digest() {
  # Mutable registry aliases do not themselves carry a semver name. Resolve
  # their manifest digest through the immutable release tags available in this
  # checkout instead of trusting workflow arrival order.
  local digest="$1"
  local tag version observed

  while IFS= read -r tag; do
    version="${tag#v}"
    observed="$(inspect_digest "$version_repository:$version" || true)"
    if [ "$observed" = "$digest" ]; then
      printf '%s\n' "$version"
      return 0
    fi
  done < <(git -c safe.directory="$repository_root" -C "$repository_root" tag --list 'v[0-9]*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true)
  return 1
}

mutable_aliases_to_promote=()
mutable_aliases_to_skip=()
mutable_alias_skip_versions=()

plan_mutable_aliases() {
  local tag inspect_status existing_digest existing_version comparison

  mutable_aliases_to_promote=()
  mutable_aliases_to_skip=()
  mutable_alias_skip_versions=()

  for tag in $target_tags; do
    [ "$tag" = "$version_tag" ] && continue

    inspect_status=0
    inspect_existing_registry_reference "$tag" || inspect_status=$?
    if [ "$inspect_status" -ne 0 ]; then
      if [ "$inspect_status" -eq 3 ]; then
        mutable_aliases_to_promote+=("$tag")
        continue
      fi
      return 1
    fi

    existing_digest="$registry_inspection_digest"

    existing_version="$(version_for_digest "$existing_digest" || true)"
    [ -n "$existing_version" ] || {
      printf 'refusing to move mutable alias %s: its digest %s is not mapped to an immutable stable release tag\n' \
        "$tag" "$existing_digest" >&2
      return 1
    }
    comparison="$(semver_compare "$existing_version" "$release_version")" || {
      printf 'refusing to move mutable alias %s: could not compare release versions\n' "$tag" >&2
      return 1
    }
    if [ "$comparison" = 1 ]; then
      mutable_aliases_to_skip+=("$tag")
      mutable_alias_skip_versions+=("$existing_version")
    else
      mutable_aliases_to_promote+=("$tag")
    fi
  done
}

existing_version_digest=""
version_inspect_status=0
inspect_existing_registry_reference "$version_tag" || version_inspect_status=$?
if [ "$version_inspect_status" -eq 0 ]; then
  existing_version_digest="$registry_inspection_digest"
  if [ "$existing_version_digest" != "$candidate_digest" ]; then
    printf 'refusing to overwrite immutable release tag %s: existing %s, candidate %s\n' \
      "$version_tag" "$existing_version_digest" "$candidate_digest" >&2
    exit 1
  fi
elif [ "$version_inspect_status" -ne 3 ]; then
  exit 1
fi

promote_and_verify() {
  local tag="$1"
  local observed=""
  local attempt

  docker buildx imagetools create --prefer-index=false -t "$tag" "$candidate_image"
  for attempt in $(seq 1 12); do
    observed="$(inspect_digest "$tag" || true)"
    [ "$observed" = "$candidate_digest" ] && break
    printf 'promoted digest not visible yet for %s (attempt %s/12)\n' "$tag" "$attempt" >&2
    sleep 10
  done
  [ "$observed" = "$candidate_digest" ] \
    || { printf 'promoted tag %s did not resolve to the qualified digest\n' "$tag" >&2; return 1; }
}

if [ "$promotion_phase" = immutable ]; then
  if [ "$existing_version_digest" = "$candidate_digest" ]; then
    printf 'immutable release tag %s already points to the qualified digest; leaving it unchanged\n' "$version_tag"
  else
    promote_and_verify "$version_tag"
  fi
  exit 0
fi

[ "$existing_version_digest" = "$candidate_digest" ] || {
  printf 'refusing mutable alias publication: immutable release tag %s is not available at candidate digest %s\n' \
    "$version_tag" "$candidate_digest" >&2
  exit 1
}

release_git_tag="${RELEASE_GIT_TAG:-v${release_version}}"
[[ "$release_git_tag" == "v${release_version}" ]] || {
  printf 'RELEASE_GIT_TAG must be v%s\n' "$release_version" >&2
  exit 1
}
git_tag_revision="$(
  git -c safe.directory="$repository_root" -C "$repository_root" \
    rev-parse "${release_git_tag}^{commit}" 2>/dev/null || true
)"
[ "$git_tag_revision" = "$candidate_revision" ] || {
  printf 'refusing mutable alias publication: Git tag %s resolves to %s instead of %s\n' \
    "$release_git_tag" "${git_tag_revision:-missing}" "$candidate_revision" >&2
  exit 1
}

# Complete every read-only comparison before changing a mutable alias. A
# delayed older workflow skips aliases that already point at a newer immutable
# release, but still succeeds so its own semver image, Git tag, and GitHub
# Release can finish publication. Unmapped or corrupt aliases fail before any
# mutable tag is changed.
plan_mutable_aliases

for index in "${!mutable_aliases_to_skip[@]}"; do
  printf 'skipping mutable alias %s: existing release %s is newer than %s\n' \
    "${mutable_aliases_to_skip[$index]}" \
    "${mutable_alias_skip_versions[$index]}" \
    "$release_version"
done

for tag in "${mutable_aliases_to_promote[@]}"; do
  promote_and_verify "$tag"
done
