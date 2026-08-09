#!/usr/bin/env bash

set -Eeuo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
temporary="$(mktemp -d "${TMPDIR:-/tmp}/nyxdoc-lifecycle-shell.XXXXXX")"
cleanup() {
  rm -rf -- "$temporary"
}
trap cleanup EXIT

cp "$root/.env.production.example" "$temporary/.env.production"
mkdir -p "$temporary/data/backups/generation-1"
printf '{}\n' >"$temporary/data/backups/generation-1/manifest.json"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=compose-common.sh
source "$root/scripts/compose-common.sh"
NYXDOC_ROOT="$temporary"
NYXDOC_ENV_FILE="$temporary/.env.production"
NYXDOC_COMPOSE_FILE="$temporary/compose.yaml"

previous_revision="1111111111111111111111111111111111111111"
target_revision="2222222222222222222222222222222222222222"
other_revision="3333333333333333333333333333333333333333"

nyxdoc_write_update_state \
  "$previous_revision" "$target_revision" v0.25.17 \
  generation-1 /backups/generation-1 \
  registry.example/nyxdoc@sha256:2222222222222222222222222222222222222222222222222222222222222222

grep -Fxq \
  'targetImage=registry.example/nyxdoc@sha256:2222222222222222222222222222222222222222222222222222222222222222' \
  "$temporary/.nyxdoc-update-state"

expected=$'generation-1\t/backups/generation-1'
# Unit-contract the receipt helper with a successful full verifier. The
# end-to-end update retry below exercises the real compose invocation.
nyxdoc_compose() { return 0; }
[ "$(nyxdoc_resumable_update_backup "$previous_revision" "$target_revision")" = "$expected" ]
[ "$(nyxdoc_resumable_update_backup "$target_revision" "$target_revision")" = "$expected" ]
if nyxdoc_write_update_state \
  "$previous_revision" "$target_revision" v0.25.17 \
  generation-1 /backups/another-generation \
  registry.example/nyxdoc@sha256:2222222222222222222222222222222222222222222222222222222222222222; then
  exit 1
fi
if nyxdoc_resumable_update_backup "$other_revision" "$target_revision"; then
  exit 1
fi
if nyxdoc_resumable_update_backup "$target_revision" "$other_revision"; then
  exit 1
fi

rm "$temporary/data/backups/generation-1/manifest.json"
if nyxdoc_resumable_update_backup "$target_revision" "$target_revision"; then
  exit 1
fi
printf '{"tampered":true}\n' >"$temporary/data/backups/generation-1/manifest.json"
if nyxdoc_resumable_update_backup "$target_revision" "$target_revision"; then
  exit 1
fi
printf '{}\n' >"$temporary/data/backups/generation-1/manifest.json"
[ "$(nyxdoc_resumable_update_backup "$target_revision" "$target_revision")" = "$expected" ]

nyxdoc_clear_update_state
[ ! -e "$(nyxdoc_update_state_file)" ]

fake_bin="$temporary/fake-bin"
registry_state="$temporary/registry-state"
docker_log="$temporary/docker.log"
mkdir -p "$fake_bin"
cp "$root/scripts/test-fixtures/fake-registry-docker.sh" "$fake_bin/docker"
chmod 0755 "$fake_bin/docker"
mv "$fake_bin/docker" "$fake_bin/docker-base"
cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

if [ "${1:-} ${2:-} ${3:-}" = "buildx imagetools inspect" ] \
  && [ "${4:-}" = "${FAKE_REGISTRY_FAILURE_REFERENCE:-}" ] \
  && [ -n "${FAKE_REGISTRY_INSPECT_DIAGNOSTIC:-}" ]; then
  printf '%s\n' "$FAKE_REGISTRY_INSPECT_DIAGNOSTIC" >&2
  exit 1
fi

if [ "${1:-} ${2:-}" = "image inspect" ] && printf '%s\n' "$@" | grep -q 'Config.Env'; then
  printf 'NODE_ENV=production\nNYXDOC_SOURCE_REVISION=%s\n' "$FAKE_CANDIDATE_REVISION"
  exit 0
fi
exec "$(dirname "$0")/docker-base" "$@"
EOF
chmod 0755 "$fake_bin/docker"
touch "$registry_state" "$docker_log"

candidate_digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
conflicting_digest="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
candidate_image="ghcr.io/getnyxdoc/nyxdoc@$candidate_digest"
version_tag="ghcr.io/getnyxdoc/nyxdoc:0.25.17"
target_tags="ghcr.io/getnyxdoc/nyxdoc:latest ghcr.io/getnyxdoc/nyxdoc:0.25 $version_tag"

promotion_root="$temporary/promotion-root"
mkdir -p "$promotion_root/scripts"
cp "$root/scripts/promote-release-image.sh" "$promotion_root/scripts/"
git init --initial-branch=main "$promotion_root" >/dev/null
git -C "$promotion_root" config user.name 'Nyxdoc promotion test'
git -C "$promotion_root" config user.email 'promotion@example.test'
git -C "$promotion_root" add scripts/promote-release-image.sh
git -C "$promotion_root" commit -m candidate >/dev/null
candidate_revision="$(git -C "$promotion_root" rev-parse HEAD)"
git -C "$promotion_root" tag -a v0.25.16 -m older
git -C "$promotion_root" tag -a v0.25.17 -m candidate
git -C "$promotion_root" tag -a v0.25.18 -m newer
git -C "$promotion_root" tag -a v0.25.19 -m newest
promotion_script="$promotion_root/scripts/promote-release-image.sh"

export FAKE_REGISTRY_STATE="$registry_state"
export FAKE_DOCKER_LOG="$docker_log"
export FAKE_CANDIDATE_DIGEST="$candidate_digest"
export FAKE_CANDIDATE_REVISION="$candidate_revision"
export CANDIDATE_IMAGE="$candidate_image"
export CANDIDATE_DIGEST="$candidate_digest"
export CANDIDATE_REVISION="$candidate_revision"
export VERSION_TAG="$version_tag"
export TARGET_TAGS="$target_tags"
export PROMOTION_PHASE=immutable

reset_registry() {
  printf '%s %s\n' "$candidate_image" "$candidate_digest" >"$registry_state"
}

PROMOTION_PHASE=""
export PROMOTION_PHASE
if PATH="$fake_bin:$PATH" bash "$promotion_script" >"$temporary/missing-phase.out" 2>"$temporary/missing-phase.err"; then
  printf 'promotion without an explicit phase unexpectedly succeeded\n' >&2
  exit 1
fi
grep -q 'PROMOTION_PHASE must be immutable or aliases' "$temporary/missing-phase.err"
PROMOTION_PHASE=immutable
export PROMOTION_PHASE

TARGET_TAGS="ghcr.io/getnyxdoc/nyxdoc:latest ghcr.io/getnyxdoc/nyxdoc:0.25"
export TARGET_TAGS
if PATH="$fake_bin:$PATH" bash "$promotion_script" >"$temporary/missing-version.out" 2>"$temporary/missing-version.err"; then
  printf 'promotion without an immutable version tag unexpectedly succeeded\n' >&2
  exit 1
fi
[ ! -s "$docker_log" ]
grep -q 'must include the exact immutable release tag' "$temporary/missing-version.err"
TARGET_TAGS="$target_tags"
export TARGET_TAGS

TARGET_TAGS="$version_tag registry.example.test/getnyxdoc/nyxdoc:latest"
export TARGET_TAGS
if PATH="$fake_bin:$PATH" bash "$promotion_script" >"$temporary/cross-repository.out" 2>"$temporary/cross-repository.err"; then
  printf 'cross-repository target unexpectedly succeeded\n' >&2
  exit 1
fi
[ ! -s "$docker_log" ]
grep -q 'outside release repository' "$temporary/cross-repository.err"
TARGET_TAGS="$target_tags"
export TARGET_TAGS

reset_registry
printf '%s %s\n' "$version_tag" "$conflicting_digest" >>"$registry_state"
if PATH="$fake_bin:$PATH" bash "$promotion_script" >"$temporary/conflict.out" 2>"$temporary/conflict.err"; then
  printf 'conflicting immutable tag unexpectedly succeeded\n' >&2
  exit 1
fi
[ ! -s "$docker_log" ]
grep -q 'refusing to overwrite immutable release tag' "$temporary/conflict.err"

# An inspection error is not proof that a tag is absent.  Generic "not
# found" diagnostics can be caused by a missing credential helper or an
# access-hidden repository, so neither case may publish a replacement tag.
for diagnostic in \
  'credential helper executable not found' \
  'repository not found: authorization required'; do
  reset_registry
  : >"$docker_log"
  export FAKE_REGISTRY_FAILURE_REFERENCE="$version_tag"
  export FAKE_REGISTRY_INSPECT_DIAGNOSTIC="$diagnostic"
  if PATH="$fake_bin:$PATH" bash "$promotion_script" >"$temporary/ambiguous-registry-error.out" 2>"$temporary/ambiguous-registry-error.err"; then
    printf 'ambiguous registry diagnostic unexpectedly permitted publication: %s\n' "$diagnostic" >&2
    exit 1
  fi
  [ ! -s "$docker_log" ]
  grep -Fq 'refusing registry publication: inspection of' "$temporary/ambiguous-registry-error.err"
  grep -Fq "$diagnostic" "$temporary/ambiguous-registry-error.err"
done
unset FAKE_REGISTRY_FAILURE_REFERENCE FAKE_REGISTRY_INSPECT_DIAGNOSTIC

reset_registry
PROMOTION_PHASE=aliases
export PROMOTION_PHASE
if PATH="$fake_bin:$PATH" bash "$promotion_script" >"$temporary/aliases-before-immutable.out" 2>"$temporary/aliases-before-immutable.err"; then
  printf 'mutable alias publication without an immutable version image unexpectedly succeeded\n' >&2
  exit 1
fi
[ ! -s "$docker_log" ]
grep -q 'immutable release tag .* is not available' "$temporary/aliases-before-immutable.err"
PROMOTION_PHASE=immutable
export PROMOTION_PHASE

reset_registry
: >"$docker_log"
PATH="$fake_bin:$PATH" bash "$promotion_script" >"$temporary/fresh-promotion.out"
[ "$(sed -n '1p' "$docker_log")" = "create $version_tag" ]
if grep -Eq 'create ghcr\.io/getnyxdoc/nyxdoc:(latest|0\.25)$' "$docker_log"; then
  printf 'immutable phase unexpectedly moved a mutable alias\n' >&2
  exit 1
fi

PROMOTION_PHASE=aliases
export PROMOTION_PHASE
PATH="$fake_bin:$PATH" bash "$promotion_script" >"$temporary/fresh-aliases.out"
grep -Fxq 'create ghcr.io/getnyxdoc/nyxdoc:latest' "$docker_log"
grep -Fxq 'create ghcr.io/getnyxdoc/nyxdoc:0.25' "$docker_log"

reset_registry
printf '%s %s\n' "$version_tag" "$candidate_digest" >>"$registry_state"
: >"$docker_log"
PATH="$fake_bin:$PATH" bash "$promotion_script" >"$temporary/retry.out"
if grep -Fxq "create $version_tag" "$docker_log"; then
  exit 1
fi
grep -Fxq 'create ghcr.io/getnyxdoc/nyxdoc:latest' "$docker_log"
grep -Fxq 'create ghcr.io/getnyxdoc/nyxdoc:0.25' "$docker_log"

# An older workflow may acquire the shared publication lock after a newer
# release has completed. Its immutable image and Git tag remain valid, so the
# aliases phase must succeed and let GitHub Release publication continue while
# explicitly skipping every alias that would move backwards.
older_version_tag="ghcr.io/getnyxdoc/nyxdoc:0.25.18"
newer_version_tag="ghcr.io/getnyxdoc/nyxdoc:0.25.19"
newer_digest="sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
{
  printf '%s %s\n' "$candidate_image" "$candidate_digest"
  printf '%s %s\n' "$older_version_tag" "$candidate_digest"
  printf '%s %s\n' "$newer_version_tag" "$newer_digest"
  printf '%s %s\n' 'ghcr.io/getnyxdoc/nyxdoc:latest' "$newer_digest"
  printf '%s %s\n' 'ghcr.io/getnyxdoc/nyxdoc:0.25' "$newer_digest"
} >"$registry_state"
: >"$docker_log"
VERSION_TAG="$older_version_tag"
TARGET_TAGS="ghcr.io/getnyxdoc/nyxdoc:latest ghcr.io/getnyxdoc/nyxdoc:0.25 $older_version_tag"
export VERSION_TAG TARGET_TAGS
PATH="$fake_bin:$PATH" bash "$promotion_script" >"$temporary/out-of-order.out" 2>"$temporary/out-of-order.err"
[ ! -s "$docker_log" ]
grep -Fq 'skipping mutable alias ghcr.io/getnyxdoc/nyxdoc:latest: existing release 0.25.19 is newer than 0.25.18' \
  "$temporary/out-of-order.out"
grep -Fq 'skipping mutable alias ghcr.io/getnyxdoc/nyxdoc:0.25: existing release 0.25.19 is newer than 0.25.18' \
  "$temporary/out-of-order.out"

# Skipping is per alias, not an early success for the whole phase. If only one
# alias is newer, the other safe alias still converges to the delayed release.
{
  printf '%s %s\n' "$candidate_image" "$candidate_digest"
  printf '%s %s\n' "$older_version_tag" "$candidate_digest"
  printf '%s %s\n' "$newer_version_tag" "$newer_digest"
  printf '%s %s\n' 'ghcr.io/getnyxdoc/nyxdoc:latest' "$newer_digest"
  printf '%s %s\n' 'ghcr.io/getnyxdoc/nyxdoc:0.25' "$candidate_digest"
} >"$registry_state"
: >"$docker_log"
PATH="$fake_bin:$PATH" bash "$promotion_script" >"$temporary/selective-skip.out" 2>"$temporary/selective-skip.err"
grep -Fxq 'create ghcr.io/getnyxdoc/nyxdoc:0.25' "$docker_log"
if grep -Fxq 'create ghcr.io/getnyxdoc/nyxdoc:latest' "$docker_log"; then
  printf 'selectively skipped newer latest alias was moved\n' >&2
  exit 1
fi
grep -Fq 'skipping mutable alias ghcr.io/getnyxdoc/nyxdoc:latest: existing release 0.25.19 is newer than 0.25.18' \
  "$temporary/selective-skip.out"

# A successful registry inspection with a malformed digest is not an absent
# alias. It is corrupt state and must fail before any otherwise-safe alias can
# move.
{
  printf '%s %s\n' "$candidate_image" "$candidate_digest"
  printf '%s %s\n' "$older_version_tag" "$candidate_digest"
  printf '%s %s\n' 'ghcr.io/getnyxdoc/nyxdoc:latest' 'not-a-digest'
} >"$registry_state"
: >"$docker_log"
if PATH="$fake_bin:$PATH" bash "$promotion_script" >"$temporary/corrupt-alias.out" 2>"$temporary/corrupt-alias.err"; then
  printf 'corrupt mutable alias unexpectedly succeeded\n' >&2
  exit 1
fi
[ ! -s "$docker_log" ]
grep -q 'returned a corrupt digest' "$temporary/corrupt-alias.err"
VERSION_TAG="$version_tag"
TARGET_TAGS="$target_tags"
PROMOTION_PHASE=aliases
export VERSION_TAG TARGET_TAGS PROMOTION_PHASE

# First-hop compatibility contract for the unmodified v0.25.17 updater. The
# final Git tag remains absent while the candidate image is unavailable and
# while the image is being published. Only after that exact semver image is
# pullable may the final tag become visible to the historical resolver.
first_hop_remote="$temporary/first-hop-origin.git"
first_hop_seed="$temporary/first-hop-seed"
first_hop_checkout="$temporary/first-hop-checkout"
first_hop_fake_bin="$temporary/first-hop-fake-bin"
first_hop_state="$temporary/first-hop-state"

git init --bare --initial-branch=main "$first_hop_remote" >/dev/null
git init --initial-branch=main "$first_hop_seed" >/dev/null
git -C "$first_hop_seed" config core.autocrlf false
git -C "$first_hop_seed" config user.name 'Nyxdoc v0.25.17 first-hop test'
git -C "$first_hop_seed" config user.email 'first-hop@example.test'
mkdir -p "$first_hop_seed/scripts"
git -c safe.directory="$root" -C "$root" show v0.25.17:scripts/update.sh >"$first_hop_seed/scripts/update.sh"
git -c safe.directory="$root" -C "$root" show v0.25.17:scripts/compose-common.sh >"$first_hop_seed/scripts/compose-common.sh"
git -c safe.directory="$root" -C "$root" show v0.25.17:.env.production.example >"$first_hop_seed/.env.production.example"
git -c safe.directory="$root" -C "$root" show v0.25.17:compose.yaml >"$first_hop_seed/compose.yaml"
printf '.env.production\ndata/\n' >"$first_hop_seed/.gitignore"
printf '{\n  "version": "0.25.17"\n}\n' >"$first_hop_seed/package.json"
git -C "$first_hop_seed" add .
git -C "$first_hop_seed" commit -m v0.25.17 >/dev/null
first_hop_baseline_revision="$(git -C "$first_hop_seed" rev-parse HEAD)"
git -C "$first_hop_seed" tag -a v0.25.17 -m v0.25.17
printf '{\n  "version": "0.25.18"\n}\n' >"$first_hop_seed/package.json"
git -C "$first_hop_seed" add package.json
git -C "$first_hop_seed" commit -m v0.25.18-candidate >/dev/null
first_hop_candidate_revision="$(git -C "$first_hop_seed" rev-parse HEAD)"
git -C "$first_hop_seed" push "$first_hop_remote" main v0.25.17 >/dev/null

git -c core.autocrlf=false clone "$first_hop_remote" "$first_hop_checkout" >/dev/null
git -C "$first_hop_checkout" checkout --detach v0.25.17 >/dev/null
test "$(git -c safe.directory="$root" -C "$root" show v0.25.17:scripts/update.sh | sha256sum | awk '{ print $1 }')" = \
  "$(sha256sum "$first_hop_checkout/scripts/update.sh" | awk '{ print $1 }')"
test "$(git -c safe.directory="$root" -C "$root" show v0.25.17:scripts/compose-common.sh | sha256sum | awk '{ print $1 }')" = \
  "$(sha256sum "$first_hop_checkout/scripts/compose-common.sh" | awk '{ print $1 }')"
cp "$first_hop_checkout/.env.production.example" "$first_hop_checkout/.env.production"
sed -i \
  -e 's#^NYXDOC_IMAGE=.*#NYXDOC_IMAGE=ghcr.io/getnyxdoc/nyxdoc:0.25.17#' \
  -e 's#^BETTER_AUTH_SECRET=.*#BETTER_AUTH_SECRET=first-hop-auth-secret-0123456789-abcdefghijklmnop#' \
  -e 's#^NYXDOC_COLLABORATION_SECRET=.*#NYXDOC_COLLABORATION_SECRET=first-hop-collaboration-secret-0123456789-abcd#' \
  "$first_hop_checkout/.env.production"

mkdir -p "$first_hop_fake_bin" "$first_hop_state"
cp "$root/scripts/test-fixtures/fake-lifecycle-docker.sh" "$first_hop_fake_bin/docker-base"
cp "$root/scripts/test-fixtures/fake-lifecycle-curl.sh" "$first_hop_fake_bin/curl"
cat >"$first_hop_fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
state="${FAKE_LIFECYCLE_STATE:?}"
root="${FAKE_LIFECYCLE_ROOT:?}"
arguments=("$@")
if [ "${1:-}" = compose ]; then
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project-directory|--env-file|-f) shift 2 ;;
      *) break ;;
    esac
  done
  if [ "${1:-}" = pull ]; then
    image="$(awk -F= '$1 == "NYXDOC_IMAGE" { print substr($0, index($0, "=") + 1); exit }' "$root/.env.production")"
    grep -Fxq "$image" "$state/published-images" || {
      printf 'image is not pullable: %s\n' "$image" >&2
      exit 1
    }
  fi
fi
exec "$(dirname "$0")/docker-base" "${arguments[@]}"
EOF
chmod 0755 "$first_hop_fake_bin/docker" "$first_hop_fake_bin/docker-base" "$first_hop_fake_bin/curl"
printf '1\n' >"$first_hop_state/running"
printf 'sha256:baseline\n' >"$first_hop_state/image-id"
printf '0\n' >"$first_hop_state/backup-count"
touch "$first_hop_state/log"
printf '%s\n' 'ghcr.io/getnyxdoc/nyxdoc:0.25.17' >"$first_hop_state/published-images"
export FAKE_LIFECYCLE_STATE="$first_hop_state"
export FAKE_LIFECYCLE_ROOT="$first_hop_checkout"

if git -C "$first_hop_checkout" ls-remote --exit-code --refs origin refs/tags/v0.25.18 >/dev/null 2>&1; then
  printf 'candidate Git tag became visible before candidate image publication\n' >&2
  exit 1
fi
PATH="$first_hop_fake_bin:$PATH" bash "$first_hop_checkout/scripts/update.sh" \
  >"$temporary/first-hop-before-image.out" 2>"$temporary/first-hop-before-image.err"
[ "$(git -C "$first_hop_checkout" rev-parse HEAD)" = "$first_hop_baseline_revision" ]

printf '%s\n' 'ghcr.io/getnyxdoc/nyxdoc:0.25.18' >>"$first_hop_state/published-images"
if git -C "$first_hop_checkout" ls-remote --exit-code --refs origin refs/tags/v0.25.18 >/dev/null 2>&1; then
  printf 'candidate Git tag became visible during candidate image publication\n' >&2
  exit 1
fi
PATH="$first_hop_fake_bin:$PATH" bash "$first_hop_checkout/scripts/update.sh" \
  >"$temporary/first-hop-after-image.out" 2>"$temporary/first-hop-after-image.err"
[ "$(git -C "$first_hop_checkout" rev-parse HEAD)" = "$first_hop_baseline_revision" ]

grep -Fxq 'ghcr.io/getnyxdoc/nyxdoc:0.25.18' "$first_hop_state/published-images"
git -C "$first_hop_seed" tag -a v0.25.18 "$first_hop_candidate_revision" -m v0.25.18
git -C "$first_hop_seed" push "$first_hop_remote" v0.25.18 >/dev/null
PATH="$first_hop_fake_bin:$PATH" bash "$first_hop_checkout/scripts/update.sh" \
  >"$temporary/first-hop-after-tag.out" 2>"$temporary/first-hop-after-tag.err"
[ "$(git -C "$first_hop_checkout" rev-parse HEAD)" = "$first_hop_candidate_revision" ]
grep -Fxq 'NYXDOC_IMAGE=ghcr.io/getnyxdoc/nyxdoc:0.25.18' "$first_hop_checkout/.env.production"

update_remote="$temporary/update-origin.git"
update_seed="$temporary/update-seed"
update_checkout="$temporary/update-checkout"
update_fake_bin="$temporary/update-fake-bin"
update_state="$temporary/update-runtime-state"

git init --bare --initial-branch=main "$update_remote" >/dev/null
git init --initial-branch=main "$update_seed" >/dev/null
git -C "$update_seed" config core.autocrlf false
git -C "$update_seed" config user.name 'Nyxdoc lifecycle test'
git -C "$update_seed" config user.email 'lifecycle@example.test'
mkdir -p "$update_seed/scripts"
cp "$root/scripts/compose-common.sh" "$root/scripts/update.sh" "$update_seed/scripts/"
cp "$root/.env.production.example" "$root/compose.yaml" "$update_seed/"
printf '.env.production\ndata/\n' >"$update_seed/.gitignore"
printf '{\n  "version": "0.25.1"\n}\n' >"$update_seed/package.json"
git -C "$update_seed" add .
git -C "$update_seed" commit -m baseline >/dev/null
git -C "$update_seed" tag -a v0.25.1 -m baseline
printf '{\n  "version": "0.25.2"\n}\n' >"$update_seed/package.json"
git -C "$update_seed" add package.json
git -C "$update_seed" commit -m candidate >/dev/null
candidate_revision="$(git -C "$update_seed" rev-parse HEAD)"
git -C "$update_seed" tag -a v0.25.2 -m candidate
git -C "$update_seed" tag -a v0.25.4 -m 'failed release must not enter stable'
git -C "$update_seed" tag -a v99.0.0-rc.1 -m 'prerelease must not enter stable'
git -C "$update_seed" push "$update_remote" main --tags >/dev/null
git -c core.autocrlf=false clone "$update_remote" "$update_checkout" >/dev/null
git -C "$update_checkout" checkout --detach v0.25.1 >/dev/null

cp "$update_checkout/.env.production.example" "$update_checkout/.env.production"
sed -i \
  -e 's#^NYXDOC_IMAGE=.*#NYXDOC_IMAGE=ghcr.io/getnyxdoc/nyxdoc:0.25.1#' \
  -e 's#^BETTER_AUTH_SECRET=.*#BETTER_AUTH_SECRET=update-auth-secret-0123456789-abcdefghijklmnopqrstuvwxyz#' \
  -e 's#^NYXDOC_COLLABORATION_SECRET=.*#NYXDOC_COLLABORATION_SECRET=update-collaboration-secret-0123456789-abcdefghijkl#' \
  "$update_checkout/.env.production"

mkdir -p "$update_fake_bin" "$update_state"
cp "$root/scripts/test-fixtures/fake-lifecycle-docker.sh" "$update_fake_bin/docker"
cp "$root/scripts/test-fixtures/fake-lifecycle-curl.sh" "$update_fake_bin/curl"
chmod 0755 "$update_fake_bin/docker" "$update_fake_bin/curl"
# Keep the existing lifecycle Docker fixture intact. This local wrapper models
# the complete backup verifier used only by interrupted-update retry tests.
mv "$update_fake_bin/docker" "$update_fake_bin/docker-base"
cat >"$update_fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

state="${FAKE_LIFECYCLE_STATE:?}"
root="${FAKE_LIFECYCLE_ROOT:?}"
original_arguments=("$@")

if [ "${1:-} ${2:-} ${3:-}" = "buildx imagetools inspect" ]; then
  reference="${4:-}"
  grep -Fxq "$reference" "$state/published-images" || exit 1
  case "$reference" in
    *:0.25.1) digest_number=1 ;;
    *:0.25.2) digest_number=2 ;;
    *:0.25.3) digest_number=3 ;;
    *) digest_number=9 ;;
  esac
  printf 'Digest: sha256:%064d\n' "$digest_number"
  exit 0
fi

if [ "${1:-} ${2:-}" = "buildx version" ]; then
  exit 0
fi

if [ "${1:-} ${2:-}" = "image inspect" ]; then
  image="${@: -1}"
  case "$image" in
    *:0.25.1|*@sha256:$(printf '%064d' 1))
      target_revision="$(git -C "$root" rev-parse v0.25.1^{commit})"
      ;;
    *:0.25.2|*@sha256:$(printf '%064d' 2))
      target_revision="$(git -C "$root" rev-parse v0.25.2^{commit})"
      ;;
    *)
      target_revision="${FAKE_OFFICIAL_TARGET_REVISION:-$(git -C "$root" rev-parse HEAD)}"
      ;;
  esac
  if printf '%s\n' "$@" | grep -q 'Config.Labels'; then
    printf '%s\n' "$target_revision"
    exit 0
  fi
  if printf '%s\n' "$@" | grep -q 'Config.Env'; then
    printf 'NODE_ENV=production\nNYXDOC_SOURCE_REVISION=%s\n' "$target_revision"
    exit 0
  fi
fi

if [ "${1:-}" = compose ]; then
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project-directory|--env-file|-f) shift 2 ;;
      *) break ;;
    esac
  done
  if [ "${1:-}" = run ] && printf '%s\n' "$*" | grep -Fq 'npm run backup:verify'; then
    generation_path="${@: -1}"
    generation_id="${generation_path##*/}"
    printf 'verify %s\n' "$generation_path" >>"$state/log"
    [ -f "$root/data/backups/$generation_id/manifest.json" ]
    [ -f "$root/data/backups/$generation_id/nyxdoc.db" ]
    [ -f "$root/data/backups/$generation_id/media/payload.bin" ]
    exit 0
  fi
fi

exec "$(dirname "$0")/docker-base" "${original_arguments[@]}"
EOF
chmod 0755 "$update_fake_bin/docker"
printf '1\n' >"$update_state/running"
printf 'sha256:baseline\n' >"$update_state/image-id"
printf '0\n' >"$update_state/backup-count"
touch "$update_state/log"
printf '%s\n' \
  'ghcr.io/getnyxdoc/nyxdoc:0.25.1' \
  'ghcr.io/getnyxdoc/nyxdoc:0.25.2' \
  >"$update_state/published-images"

export FAKE_LIFECYCLE_STATE="$update_state"
export FAKE_LIFECYCLE_ROOT="$update_checkout"
export NYXDOC_OFFICIAL_RELEASE_SOURCE="$update_remote"
export FAKE_OFFICIAL_TARGET_REVISION="$candidate_revision"

# A registry/build failure must not replace the known-good image in .env.
# Otherwise the preserved backup cannot be verified during a later retry.
touch "$update_state/fail-next-pull"
if NYXDOC_UPDATE_IMAGE='registry.invalid/nyxdoc:lifecycle-failure' \
  PATH="$update_fake_bin:$PATH" bash "$update_checkout/scripts/update.sh" \
    >"$temporary/update-pull-failure.out" 2>"$temporary/update-pull-failure.err"; then
  printf 'injected image-pull failure unexpectedly succeeded\n' >&2
  exit 1
fi
[ "$(git -C "$update_checkout" rev-parse HEAD)" = "$candidate_revision" ]
[ "$(cat "$update_state/running")" = 1 ]
[ "$(cat "$update_state/backup-count")" = 1 ]
[ -f "$update_checkout/.nyxdoc-update-state" ]
grep -Fxq 'NYXDOC_IMAGE=ghcr.io/getnyxdoc/nyxdoc:0.25.1' "$update_checkout/.env.production"
grep -q 'Skipping unqualified stable tag v0.25.4' "$temporary/update-pull-failure.err"

# Return to the release baseline so the following case exercises a separate
# stopped-app retry after an update failure, rather than sharing state with the
# pull-failure contract above.
git -C "$update_checkout" checkout --detach v0.25.1 >/dev/null
rm -f "$update_checkout/.nyxdoc-update-state"
printf '1\n' >"$update_state/running"
printf 'sha256:baseline\n' >"$update_state/image-id"
printf '0\n' >"$update_state/backup-count"
: >"$update_state/log"
touch "$update_state/fail-next-up"

if PATH="$update_fake_bin:$PATH" bash "$update_checkout/scripts/update.sh" >"$temporary/update-first.out" 2>"$temporary/update-first.err"; then
  printf 'injected update interruption unexpectedly succeeded\n' >&2
  exit 1
fi
if [ "$(git -C "$update_checkout" rev-parse HEAD)" != "$candidate_revision" ]; then
  printf 'interrupted update did not reach the selected target revision\n' >&2
  cat "$temporary/update-first.out" >&2
  cat "$temporary/update-first.err" >&2
  exit 1
fi
if [ "$(cat "$update_state/running")" != 0 ]; then
  printf 'injected interruption did not leave the app stopped\n' >&2
  cat "$temporary/update-first.out" >&2
  cat "$temporary/update-first.err" >&2
  exit 1
fi
[ "$(cat "$update_state/backup-count")" = 1 ]
[ -f "$update_checkout/.nyxdoc-update-state" ]
gateway_stop_line="$(grep -n -m1 '^stop -t 20 gateway$' "$update_state/log" | cut -d: -f1)"
collaboration_stop_line="$(grep -n -m1 '^stop -t 20 collaboration$' "$update_state/log" | cut -d: -f1)"
app_stop_line="$(grep -n -m1 '^stop -t 20 app$' "$update_state/log" | cut -d: -f1)"
migration_line="$(grep -n -m1 '^migrate$' "$update_state/log" | cut -d: -f1)"
restart_line="$(grep -n -m1 '^up -d --no-build --remove-orphans$' "$update_state/log" | cut -d: -f1)"
[ "$gateway_stop_line" -lt "$collaboration_stop_line" ]
[ "$collaboration_stop_line" -lt "$app_stop_line" ]
[ "$app_stop_line" -lt "$migration_line" ]
[ "$migration_line" -lt "$restart_line" ]

# A newer completed release can appear after the interruption. The retry must
# still recover the receipt's exact v0.25.2 target; only a later clean run may
# resolve and advance to v0.25.3.
printf '{\n  "version": "0.25.3"\n}\n' >"$update_seed/package.json"
git -C "$update_seed" add package.json
git -C "$update_seed" commit -m next-release >/dev/null
next_revision="$(git -C "$update_seed" rev-parse HEAD)"
git -C "$update_seed" tag -a v0.25.3 -m next-release
git -C "$update_seed" push "$update_remote" main v0.25.3 >/dev/null
printf '%s\n' 'ghcr.io/getnyxdoc/nyxdoc:0.25.3' >>"$update_state/published-images"

# The receipt manifest is still intact, but a payload file is gone. A retry
# must refuse before it restarts the app or clears the receipt.
mkdir -p "$update_checkout/data/backups/generation-1/media"
printf 'database\n' >"$update_checkout/data/backups/generation-1/nyxdoc.db"
printf 'media\n' >"$update_checkout/data/backups/generation-1/media/payload.bin"
# Keep the receipt's manifest anchor valid. The retry must reach the full
# verifier and reject the missing payload rather than failing only because a
# test fixture changed its manifest after the receipt was written.
manifest_sha256="$(sha256sum "$update_checkout/data/backups/generation-1/manifest.json" | awk '{ print $1 }')"
sed -i "s/^backupManifestSha256=.*/backupManifestSha256=$manifest_sha256/" \
  "$update_checkout/.nyxdoc-update-state"
rm "$update_checkout/data/backups/generation-1/media/payload.bin"
if PATH="$update_fake_bin:$PATH" bash "$update_checkout/scripts/update.sh" >"$temporary/update-corrupt-retry.out" 2>"$temporary/update-corrupt-retry.err"; then
  printf 'interrupted update retry accepted a backup with a missing payload\n' >&2
  exit 1
fi
[ "$(cat "$update_state/running")" = 0 ]
[ -f "$update_checkout/.nyxdoc-update-state" ]
grep -Fxq 'verify /backups/generation-1' "$update_state/log"
printf 'media\n' >"$update_checkout/data/backups/generation-1/media/payload.bin"

PATH="$update_fake_bin:$PATH" bash "$update_checkout/scripts/update.sh" >"$temporary/update-retry.out" 2>"$temporary/update-retry.err"
[ "$(git -C "$update_checkout" rev-parse HEAD)" = "$candidate_revision" ]
[ "$(cat "$update_state/running")" = 1 ]
[ "$(cat "$update_state/image-id")" = 'sha256:candidate' ]
[ "$(cat "$update_state/backup-count")" = 1 ]
[ ! -e "$update_checkout/.nyxdoc-update-state" ]
grep -q 'resuming the interrupted update with its verified pre-update backup' "$temporary/update-retry.out"
grep -q 'Recovering the receipt target v0.25.2' "$temporary/update-retry.out"

export FAKE_OFFICIAL_TARGET_REVISION="$next_revision"
PATH="$update_fake_bin:$PATH" bash "$update_checkout/scripts/update.sh" >"$temporary/update-next.out" 2>"$temporary/update-next.err"
[ "$(git -C "$update_checkout" rev-parse HEAD)" = "$next_revision" ]
[ "$(cat "$update_state/running")" = 1 ]
[ "$(cat "$update_state/image-id")" = 'sha256:custom' ]
[ "$(cat "$update_state/backup-count")" = 2 ]
[ ! -e "$update_checkout/.nyxdoc-update-state" ]
grep -q 'Skipping unqualified stable tag v0.25.4' "$temporary/update-next.err"

# A repository containing only unqualified tags is not a release source.
# Fail before creating another backup or changing the healthy service.
: >"$update_state/published-images"
if PATH="$update_fake_bin:$PATH" bash "$update_checkout/scripts/update.sh" >"$temporary/update-unqualified.out" 2>"$temporary/update-unqualified.err"; then
  printf 'stable resolver accepted an unqualified Git tag\n' >&2
  exit 1
fi
[ "$(cat "$update_state/backup-count")" = 2 ]
[ "$(cat "$update_state/running")" = 1 ]
grep -q 'No stable Git tag with a verifiably published semver image' "$temporary/update-unqualified.err"

unset NYXDOC_OFFICIAL_RELEASE_SOURCE FAKE_OFFICIAL_TARGET_REVISION

# The updater shipped in v0.25.17 creates its pre-update backup before it can
# load target-release code. The target release therefore provides a standalone
# bridge that closes the public gateway, proves the WebSocket boundary drained,
# snapshots while collaboration is still alive, then stops collaboration before
# handing an exact v0.25.18 target to that old updater.
bridge_root="$temporary/legacy-update-bridge"
bridge_origin="$temporary/legacy-update-bridge-origin.git"
bridge_fake_bin="$temporary/legacy-update-bridge-bin"
bridge_state="$temporary/legacy-update-bridge-state"
mkdir -p "$bridge_root/scripts" "$bridge_fake_bin" "$bridge_state"
git -c safe.directory="$root" -C "$root" show v0.25.17:scripts/compose-common.sh \
  >"$bridge_root/scripts/compose-common.sh"
cp "$root/scripts/update-bootstrap.sh" "$bridge_root/scripts/update-bootstrap.sh"
cat >"$bridge_root/scripts/update.sh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'update legacy_quiesced=%s\n' "${NYXDOC_LEGACY_UPDATE_QUIESCED:-missing}" \
  >>"$BRIDGE_STATE/log"
if [ "${NYXDOC_LEGACY_UPDATE_QUIESCED:-}" = 1 ]; then
  git -C "${NYXDOC_UPDATE_ROOT:?}" fetch --no-tags origin refs/tags/v0.25.18 >/dev/null
  git -C "$NYXDOC_UPDATE_ROOT" checkout --detach FETCH_HEAD >/dev/null
  if [ -e "$BRIDGE_STATE/fail-after-checkout" ]; then
    rm -f "$BRIDGE_STATE/fail-after-checkout"
    printf 'injected failure after checkout\n' >>"$BRIDGE_STATE/log"
    exit 73
  fi
fi
if [ -n "${NYXDOC_UPDATE_IMAGE:-}" ]; then
  [ -n "${NYXDOC_UPDATE_IMAGE:-}" ]
  temporary="$(mktemp "${NYXDOC_UPDATE_ROOT:?}/.env.production.tmp.XXXXXX")"
  awk -v image="$NYXDOC_UPDATE_IMAGE" '
    index($0, "NYXDOC_IMAGE=") == 1 { print "NYXDOC_IMAGE=" image; next }
    { print }
  ' "$NYXDOC_UPDATE_ROOT/.env.production" >"$temporary"
  mv -f "$temporary" "$NYXDOC_UPDATE_ROOT/.env.production"
  printf '%s\n' "$NYXDOC_UPDATE_IMAGE" >"$BRIDGE_STATE/current-image"
  rm -f "$BRIDGE_STATE/gateway-stopped" "$BRIDGE_STATE/collaboration-stopped"
  rm -f "$NYXDOC_UPDATE_ROOT/.nyxdoc-update-state"
fi
EOF
cat >"$bridge_fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
state="$BRIDGE_STATE"
root="${NYXDOC_UPDATE_ROOT:?}"
bridge_digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
if [ "${1:-} ${2:-}" = "buildx version" ]; then exit 0; fi
if [ "${1:-} ${2:-} ${3:-}" = "buildx imagetools inspect" ]; then
  printf 'Name: %s\nDigest: %s\n' "${4:-unknown}" "$bridge_digest"
  exit 0
fi
if [ "${1:-} ${2:-}" = "image inspect" ]; then
  if printf '%s\n' "$@" | grep -q 'Config.Labels'; then
    printf '%s\n' "${BRIDGE_TARGET_REVISION:?}"
  elif printf '%s\n' "$@" | grep -q 'Config.Env'; then
    printf 'NODE_ENV=production\nNYXDOC_SOURCE_REVISION=%s\n' "${BRIDGE_TARGET_REVISION:?}"
  else
    printf 'sha256:bridge-candidate-id\n'
  fi
  exit 0
fi
if [ "${1:-}" = inspect ]; then
  printf 'sha256:bridge-candidate-id\n'
  exit 0
fi
if [ "${1:-}" = pull ]; then exit 0; fi
if [ "${1:-} ${2:-}" = "compose version" ]; then exit 0; fi
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
  ps)
    services=" $* "
    if [[ "$services" == *" app "* ]]; then printf 'app-id\n'; fi
    if [[ "$services" == *" gateway "* ]] && [ ! -e "$state/gateway-stopped" ]; then
      printf 'gateway-id\n'
    fi
    if [[ "$services" == *" collaboration "* ]] && [ ! -e "$state/collaboration-stopped" ]; then
      printf 'collaboration-id\n'
    fi
    ;;
  stop)
    service="${!#}"
    printf 'stop %s\n' "$service" >>"$state/log"
    touch "$state/${service}-stopped"
    ;;
  exec)
    arguments=" $* "
    if [[ "$arguments" == *" collaboration node "* ]]; then
      printf '0\n'
      exit 0
    fi
    if [[ "$arguments" == *" backup:create "* ]]; then
      generation_id='legacy-bridge-generation'
      mkdir -p "$root/data/backups/$generation_id"
      printf '{"format":"nyxdoc-backup/v2"}\n' \
        >"$root/data/backups/$generation_id/manifest.json"
      printf 'backup create\n' >>"$state/log"
      printf '{\n  "status": "verified",\n  "generationId": "%s",\n  "generationPath": "/backups/%s"\n}\n' \
        "$generation_id" "$generation_id"
      exit 0
    fi
    if [[ "$arguments" == *" backup:verify "* ]]; then
      [ -f "$root/data/backups/legacy-bridge-generation/manifest.json" ]
      printf 'backup verify\n' >>"$state/log"
      exit 0
    fi
    printf 'unexpected docker compose exec: %s\n' "$*" >&2
    exit 2
    ;;
  up)
    printf 'up %s\n' "$*" >>"$state/log"
    ;;
  *) printf 'unexpected docker compose command: %s %s\n' "$command" "$*" >&2; exit 2 ;;
esac
EOF
cat >"$bridge_root/package.json" <<'EOF'
{
  "version": "0.25.17"
}
EOF
cat >"$bridge_root/.env.production" <<'EOF'
BETTER_AUTH_SECRET=legacy-bridge-auth-secret-0123456789
NYXDOC_COLLABORATION_SECRET=legacy-bridge-collaboration-secret-0123456789
NYXDOC_IMAGE=ghcr.io/getnyxdoc/nyxdoc:0.25.17
EOF
: >"$bridge_root/compose.yaml"
: >"$bridge_state/log"
chmod 0755 "$bridge_root/scripts/"*.sh "$bridge_fake_bin/docker"
git -C "$bridge_root" init --initial-branch=main >/dev/null
git -C "$bridge_root" config user.name 'Nyxdoc lifecycle test'
git -C "$bridge_root" config user.email 'lifecycle@example.invalid'
git -C "$bridge_root" add package.json compose.yaml scripts
git -C "$bridge_root" commit -m v0.25.17 >/dev/null
bridge_baseline_revision="$(git -C "$bridge_root" rev-parse HEAD)"
git -C "$bridge_root" tag -a v0.25.17 -m v0.25.17
printf '{\n  "version": "0.25.18"\n}\n' >"$bridge_root/package.json"
git -C "$bridge_root" add package.json
git -C "$bridge_root" commit -m v0.25.18 >/dev/null
bridge_target_revision="$(git -C "$bridge_root" rev-parse HEAD)"
git -C "$bridge_root" tag -a v0.25.18 -m v0.25.18
git init --bare --initial-branch=main "$bridge_origin" >/dev/null
git -C "$bridge_root" remote add origin "$bridge_origin"
git -C "$bridge_root" push origin main v0.25.17 v0.25.18 >/dev/null
git -C "$bridge_root" checkout --detach "$bridge_baseline_revision" >/dev/null
export NYXDOC_OFFICIAL_RELEASE_SOURCE="$bridge_origin"
printf '{\n  "version": "0.25.16"\n}\n' >"$bridge_root/package.json"
if BRIDGE_STATE="$bridge_state" \
  BRIDGE_TARGET_REVISION="$bridge_target_revision" \
  NYXDOC_UPDATE_ROOT="$bridge_root" \
  PATH="$bridge_fake_bin:$PATH" \
  bash "$bridge_root/scripts/update-bootstrap.sh" \
    >"$temporary/legacy-update-bridge-too-old.out" \
    2>"$temporary/legacy-update-bridge-too-old.err"; then
  printf 'legacy first-hop bridge unexpectedly accepted 0.25.16\n' >&2
  exit 1
fi
grep -Fq 'supports exactly 0.25.17' "$temporary/legacy-update-bridge-too-old.err"
git -C "$bridge_root" checkout -- package.json
BRIDGE_STATE="$bridge_state" \
  BRIDGE_TARGET_REVISION="$bridge_target_revision" \
  NYXDOC_UPDATE_ROOT="$bridge_root" \
  PATH="$bridge_fake_bin:$PATH" \
  bash "$bridge_root/scripts/update-bootstrap.sh" >"$temporary/legacy-update-bridge.out"
[ "$(git -C "$bridge_root" rev-parse HEAD)" = "$bridge_target_revision" ]
[ ! -e "$bridge_root/.nyxdoc-update-state" ]
gateway_line="$(grep -n -m1 '^stop gateway$' "$bridge_state/log" | cut -d: -f1)"
backup_line="$(grep -n -m1 '^backup create$' "$bridge_state/log" | cut -d: -f1)"
collaboration_line="$(grep -n -m1 '^stop collaboration$' "$bridge_state/log" | cut -d: -f1)"
update_line="$(grep -n -m1 '^update legacy_quiesced=1$' "$bridge_state/log" | cut -d: -f1)"
[ "$gateway_line" -lt "$backup_line" ]
[ "$backup_line" -lt "$collaboration_line" ]
[ "$collaboration_line" -lt "$update_line" ]
grep -Fxq 'backup verify' "$bridge_state/log"
grep -Fq 'Legacy bridge verified backup: /backups/legacy-bridge-generation' \
  "$temporary/legacy-update-bridge.out"

# Once an installation is beyond the legacy boundary, the same entry point is
# only a transparent hand-off and must not stop healthy services.
: >"$bridge_state/log"
rm -f "$bridge_state/gateway-stopped" "$bridge_state/collaboration-stopped"
BRIDGE_STATE="$bridge_state" \
  BRIDGE_TARGET_REVISION="$bridge_target_revision" \
  NYXDOC_UPDATE_ROOT="$bridge_root" \
  PATH="$bridge_fake_bin:$PATH" \
  bash "$bridge_root/scripts/update-bootstrap.sh" >"$temporary/current-update-bridge.out"
[ "$(cat "$bridge_state/log")" = 'update legacy_quiesced=missing' ]

# If the legacy updater fails after changing source but before writing the new
# image configuration, the next bootstrap invocation must reuse the exact
# digest recorded by the bridge instead of resolving the mutable tag again.
git -C "$bridge_root" checkout --detach "$bridge_baseline_revision" >/dev/null
git -C "$bridge_root" checkout -- .
sed -i \
  's#^NYXDOC_IMAGE=.*#NYXDOC_IMAGE=ghcr.io/getnyxdoc/nyxdoc:0.25.17#' \
  "$bridge_root/.env.production"
: >"$bridge_state/log"
rm -f \
  "$bridge_state/current-image" \
  "$bridge_state/gateway-stopped" \
  "$bridge_state/collaboration-stopped"
touch "$bridge_state/fail-after-checkout"
if BRIDGE_STATE="$bridge_state" \
  BRIDGE_TARGET_REVISION="$bridge_target_revision" \
  NYXDOC_UPDATE_ROOT="$bridge_root" \
  PATH="$bridge_fake_bin:$PATH" \
  bash "$bridge_root/scripts/update-bootstrap.sh" \
    >"$temporary/legacy-update-bridge-interrupted.out" \
    2>"$temporary/legacy-update-bridge-interrupted.err"; then
  printf 'injected legacy hand-off interruption unexpectedly succeeded\n' >&2
  exit 1
fi
[ "$(git -C "$bridge_root" rev-parse HEAD)" = "$bridge_target_revision" ]
grep -Fxq \
  'targetImage=ghcr.io/getnyxdoc/nyxdoc@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  "$bridge_root/.nyxdoc-update-state"
[ "$(awk -F= '$1 == "NYXDOC_IMAGE" { print $2; exit }' "$bridge_root/.env.production")" = \
  'ghcr.io/getnyxdoc/nyxdoc:0.25.17' ]

BRIDGE_STATE="$bridge_state" \
  BRIDGE_TARGET_REVISION="$bridge_target_revision" \
  NYXDOC_UPDATE_ROOT="$bridge_root" \
  PATH="$bridge_fake_bin:$PATH" \
  bash "$bridge_root/scripts/update-bootstrap.sh" \
    >"$temporary/legacy-update-bridge-retry.out" \
    2>"$temporary/legacy-update-bridge-retry.err"
[ ! -e "$bridge_root/.nyxdoc-update-state" ]
[ "$(cat "$bridge_state/current-image")" = \
  'ghcr.io/getnyxdoc/nyxdoc@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ]
grep -Fxq 'update legacy_quiesced=missing' "$bridge_state/log"
unset NYXDOC_OFFICIAL_RELEASE_SOURCE

install_root="$temporary/install-root"
install_fake_bin="$temporary/install-fake-bin"
install_state="$temporary/install-runtime-state"
mkdir -p "$install_root/scripts" "$install_fake_bin" "$install_state"
cp \
  "$root/scripts/compose-common.sh" \
  "$root/scripts/install.sh" \
  "$root/scripts/uninstall.sh" \
  "$install_root/scripts/"
cp "$root/.env.production.example" "$root/compose.yaml" "$root/package.json" "$install_root/"
cp "$root/scripts/test-fixtures/fake-lifecycle-docker.sh" "$install_fake_bin/docker"
cp "$root/scripts/test-fixtures/fake-lifecycle-curl.sh" "$install_fake_bin/curl"
chmod 0755 "$install_fake_bin/docker" "$install_fake_bin/curl" "$install_root/scripts/"*.sh
git -C "$install_root" init -q
git -C "$install_root" config user.name nyxdoc-test
git -C "$install_root" config user.email nyxdoc-test@example.invalid
git -C "$install_root" add .
git -C "$install_root" commit -qm 'install fixture'
install_revision="$(git -C "$install_root" rev-parse HEAD)"
printf '0\n' >"$install_state/running"
printf 'sha256:custom\n' >"$install_state/image-id"
printf '0\n' >"$install_state/backup-count"
touch "$install_state/fail-next-up" "$install_state/log"

export FAKE_LIFECYCLE_STATE="$install_state"
export FAKE_LIFECYCLE_ROOT="$install_root"
export FAKE_LIFECYCLE_SOURCE_REVISION="$install_revision"
if PATH="$install_fake_bin:$PATH" bash "$install_root/scripts/install.sh" >"$temporary/install-first.out" 2>"$temporary/install-first.err"; then
  printf 'injected first-install interruption unexpectedly succeeded\n' >&2
  exit 1
fi
[ -f "$install_root/.env.production" ]
[ "$(cat "$install_state/running")" = 0 ]
install_migration_line="$(grep -n -m1 '^migrate$' "$install_state/log" | cut -d: -f1)"
install_prepare_line="$(grep -n -m1 '^prepare-runtime-paths$' "$install_state/log" | cut -d: -f1)"
install_up_line="$(grep -n -m1 '^up -d --no-build --remove-orphans$' "$install_state/log" | cut -d: -f1)"
[ "$install_prepare_line" -lt "$install_migration_line" ]
[ "$install_migration_line" -lt "$install_up_line" ]
expected_install_image="ghcr.io/getnyxdoc/nyxdoc@sha256:$(printf '%064d' 2)"
[ "$(awk -F= '$1 == "NYXDOC_IMAGE" { print substr($0, index($0, "=") + 1); exit }' "$install_root/.env.production")" = "$expected_install_image" ]
auth_secret_before="$(awk -F= '$1 == "BETTER_AUTH_SECRET" { print substr($0, index($0, "=") + 1); exit }' "$install_root/.env.production")"
collaboration_secret_before="$(awk -F= '$1 == "NYXDOC_COLLABORATION_SECRET" { print substr($0, index($0, "=") + 1); exit }' "$install_root/.env.production")"
[ "${#auth_secret_before}" -ge 32 ]
[ "${#collaboration_secret_before}" -ge 32 ]
[ "$auth_secret_before" != "$collaboration_secret_before" ]

printf 'NYXDOC_SOURCE_REVISION=%040d\n' 9 >>"$install_root/.env.production"
PATH="$install_fake_bin:$PATH" bash "$install_root/scripts/install.sh" >"$temporary/install-retry.out" 2>"$temporary/install-retry.err"
[ "$(cat "$install_state/running")" = 1 ]
[ "$(grep -c '^migrate$' "$install_state/log")" = 2 ]
[ "$(grep -c '^prepare-runtime-paths$' "$install_state/log")" = 2 ]
! grep -q '^NYXDOC_SOURCE_REVISION=' "$install_root/.env.production"
[ "$(awk -F= '$1 == "BETTER_AUTH_SECRET" { print substr($0, index($0, "=") + 1); exit }' "$install_root/.env.production")" = "$auth_secret_before" ]
[ "$(awk -F= '$1 == "NYXDOC_COLLABORATION_SECRET" { print substr($0, index($0, "=") + 1); exit }' "$install_root/.env.production")" = "$collaboration_secret_before" ]
[ "$(awk -F= '$1 == "NYXDOC_IMAGE" { print substr($0, index($0, "=") + 1); exit }' "$install_root/.env.production")" = "$expected_install_image" ]

up_count_before="$(grep -c '^up ' "$install_state/log")"
export FAKE_LIFECYCLE_FOREIGN_VOLUME_USER=1
if PATH="$install_fake_bin:$PATH" bash "$install_root/scripts/install.sh" >"$temporary/install-volume-conflict.out" 2>"$temporary/install-volume-conflict.err"; then
  printf 'install accepted a data volume used by foreign containers\n' >&2
  exit 1
fi
unset FAKE_LIFECYCLE_FOREIGN_VOLUME_USER
grep -Fq 'data volume is in use by different or incomplete services' "$temporary/install-volume-conflict.err"
[ "$(grep -c '^up ' "$install_state/log")" = "$up_count_before" ]

export FAKE_LIFECYCLE_DUPLICATE_SOURCE_REVISION=1
if PATH="$install_fake_bin:$PATH" bash "$install_root/scripts/install.sh" >"$temporary/install-duplicate-revision.out" 2>"$temporary/install-duplicate-revision.err"; then
  printf 'install accepted an image with duplicate source revision provenance\n' >&2
  exit 1
fi
unset FAKE_LIFECYCLE_DUPLICATE_SOURCE_REVISION
grep -Fq 'exactly one NYXDOC_SOURCE_REVISION' "$temporary/install-duplicate-revision.err"
[ "$(cat "$install_state/running")" = 1 ]
[ "$(awk -F= '$1 == "NYXDOC_IMAGE" { print substr($0, index($0, "=") + 1); exit }' "$install_root/.env.production")" = "$expected_install_image" ]

backup_root="$install_root/data/backups"
mkdir -p "$backup_root"
printf 'preserve-backups\n' >"$backup_root/preserve.txt"
PATH="$install_fake_bin:$PATH" bash "$install_root/scripts/uninstall.sh" >"$temporary/uninstall-preserve.out"
[ "$(cat "$install_state/running")" = 0 ]
[ -f "$install_root/.env.production" ]
[ "$(cat "$backup_root/preserve.txt")" = preserve-backups ]
grep -Fxq 'down --remove-orphans' "$install_state/log"
if grep -q '^down .*--volumes' "$install_state/log"; then
  printf 'normal uninstall unexpectedly requested volume deletion\n' >&2
  exit 1
fi

PATH="$install_fake_bin:$PATH" bash "$install_root/scripts/install.sh" >"$temporary/install-after-stop.out"
down_count_before="$(grep -c '^down ' "$install_state/log")"
if PATH="$install_fake_bin:$PATH" bash "$install_root/scripts/uninstall.sh" --purge >"$temporary/purge-unconfirmed.out" 2>"$temporary/purge-unconfirmed.err"; then
  printf 'unconfirmed purge unexpectedly succeeded\n' >&2
  exit 1
fi
[ "$(grep -c '^down ' "$install_state/log")" = "$down_count_before" ]
[ "$(cat "$install_state/running")" = 1 ]

PATH="$install_fake_bin:$PATH" bash "$install_root/scripts/uninstall.sh" --purge --confirm-purge=nyxdoc >"$temporary/purge.out"
[ "$(cat "$install_state/running")" = 0 ]
[ "$(cat "$install_state/backup-count")" = 1 ]
[ -f "$install_root/.env.production" ]
[ "$(cat "$backup_root/preserve.txt")" = preserve-backups ]
grep -Fxq 'down --volumes --remove-orphans --rmi local' "$install_state/log"

printf 'Lifecycle shell install/update interruption retries, preserve/purge, backup receipt, and immutable promotion contracts passed.\n'
