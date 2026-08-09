#!/usr/bin/env bash

# Focused fail-closed contract for combining an updater checkout with an
# official GHCR image. This intentionally uses a synthetic Git origin so the
# checkout SHA and image provenance can be varied independently.

set -Eeuo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
temporary="$(mktemp -d "${TMPDIR:-/tmp}/nyxdoc-update-revision.XXXXXX")"
cleanup() {
  rm -rf -- "$temporary"
}
trap cleanup EXIT

origin="$temporary/official-origin.git"
private_origin="$temporary/private-origin.git"
seed="$temporary/seed"
private_seed="$temporary/private-seed"
fake_bin="$temporary/fake-bin"
mkdir -p "$seed/scripts" "$private_seed/scripts" "$fake_bin"
git init --bare --initial-branch=main "$origin" >/dev/null
git init --bare --initial-branch=main "$private_origin" >/dev/null
git init --initial-branch=main "$seed" >/dev/null
git -C "$seed" config core.autocrlf false
git -C "$seed" config user.name 'Nyxdoc update provenance test'
git -C "$seed" config user.email 'update-provenance@example.test'
cp "$root/scripts/compose-common.sh" "$root/scripts/update.sh" "$seed/scripts/"
cp "$root/.env.production.example" "$root/compose.yaml" "$seed/"
printf '.env.production\ndata/\n' >"$seed/.gitignore"
printf '{\n  "version": "0.25.18"\n}\n' >"$seed/package.json"
git -C "$seed" add .
git -C "$seed" commit -m 'v0.25.17 synthetic baseline' >/dev/null
baseline_revision="$(git -C "$seed" rev-parse HEAD)"
printf 'synthetic release 0.25.18\n' >"$seed/RELEASE"
git -C "$seed" add package.json RELEASE
git -C "$seed" commit -m 'v0.25.18 synthetic release' >/dev/null
target_revision="$(git -C "$seed" rev-parse HEAD)"
git -C "$seed" tag -a v0.25.18 -m v0.25.18
git -C "$seed" push "$origin" main v0.25.18 >/dev/null

# A private Forgejo-style checkout can contain the same installed version while
# having no shared Git ancestry with the canonical public release repository.
git init --initial-branch=main "$private_seed" >/dev/null
git -C "$private_seed" config core.autocrlf false
git -C "$private_seed" config user.name 'Nyxdoc private mirror test'
git -C "$private_seed" config user.email 'private-mirror@example.test'
cp "$root/scripts/compose-common.sh" "$root/scripts/update.sh" "$private_seed/scripts/"
cp "$root/.env.production.example" "$root/compose.yaml" "$private_seed/"
printf '.env.production\ndata/\n' >"$private_seed/.gitignore"
printf '{\n  "version": "0.25.17"\n}\n' >"$private_seed/package.json"
printf 'unrelated private mirror history\n' >"$private_seed/PRIVATE"
git -C "$private_seed" add .
git -C "$private_seed" commit -m 'private v0.25.17 baseline' >/dev/null
git -C "$private_seed" push "$private_origin" main >/dev/null

cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

root="${FAKE_UPDATE_ROOT:?}"
log="${FAKE_UPDATE_LOG:?}"

if [ "${1:-} ${2:-}" = "buildx version" ]; then exit 0; fi
if [ "${1:-} ${2:-} ${3:-}" = "buildx imagetools inspect" ]; then
  printf 'Digest: sha256:%064d\n' 1
  exit 0
fi
if [ "${1:-} ${2:-}" = "image inspect" ]; then
  image="${@: -1}"
  configured_image="$(awk -F= '$1 == "NYXDOC_IMAGE" { print substr($0, index($0, "=") + 1); exit }' \
    "$root/.env.production")"
  if [ "$image" = "$configured_image" ]; then
    inspected_revision="$(git -C "$root" rev-parse HEAD)"
  else
    inspected_revision="${FAKE_ENV_REVISION:-missing}"
  fi
  if printf '%s\n' "$@" | grep -q 'org.opencontainers.image.revision'; then
    printf 'metadata oci %s\n' "$image" >>"$log"
    [ "${FAKE_OCI_REVISION:-missing}" != missing ] \
      && printf '%s\n' "$FAKE_OCI_REVISION"
    exit 0
  fi
  if printf '%s\n' "$@" | grep -q 'Config.Env'; then
    printf 'metadata env %s\n' "$image" >>"$log"
    printf 'NODE_ENV=production\n'
    [ "$inspected_revision" != missing ] \
      && printf 'NYXDOC_SOURCE_REVISION=%s\n' "$inspected_revision"
    exit 0
  fi
  if printf '%s\n' "$@" | grep -q 'RepoDigests'; then
    # Local builds legitimately have no repository digest. The updater must
    # still retain the Docker image ID in its durable receipt.
    exit 0
  fi
  printf 'sha256:official-image\n'
  exit 0
fi
if [ "${1:-}" = inspect ]; then
  printf 'sha256:official-image\n'
  exit 0
fi
if [ "${1:-}" = ps ]; then
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
  version|config|logs) exit 0 ;;
  pull)
    printf 'pull\n' >>"$log"
    exit 0
    ;;
  build)
    printf 'build %s\n' "$*" >>"$log"
    exit 0
    ;;
  up)
    image="$(awk -F= '$1 == "NYXDOC_IMAGE" { print substr($0, index($0, "=") + 1); exit }' \
      "$root/.env.production")"
    receipt=absent
    [ ! -f "$root/.nyxdoc-update-state" ] || receipt=present
    printf 'up %s image=%s receipt=%s\n' "$*" "$image" "$receipt" >>"$log"
    exit 0
    ;;
  exec)
    if printf '%s\n' "$*" | grep -Fq 'npm run backup:create'; then
      mkdir -p "$root/data/backups/generation-1"
      source_revision="${FAKE_BACKUP_SOURCE_REVISION:-$(git -C "$root" rev-parse HEAD)}"
      printf '{\n  "sourceRevision": "%s"\n}\n' "$source_revision" \
        >"$root/data/backups/generation-1/manifest.json"
      printf '{\n  "status": "verified",\n  "generationId": "generation-1",\n  "generationPath": "/backups/generation-1",\n  "sourceRevision": "%s"\n}\n' \
        "$source_revision"
    fi
    exit 0
    ;;
  run)
    if printf '%s\n' "$*" | grep -Fq 'app true'; then
      printf 'prepare-runtime-paths\n' >>"$log"
      exit 0
    fi
    if printf '%s\n' "$*" | grep -Fq 'npm run backup:verify'; then
      generation_path="${@: -1}"
      generation_id="${generation_path##*/}"
      [ -f "$root/data/backups/$generation_id/manifest.json" ]
      printf 'verify %s\n' "$generation_path" >>"$log"
      exit 0
    fi
    if printf '%s\n' "$*" | grep -Fq 'npm run db:migrate'; then
      printf 'migrate\n' >>"$log"
      exit 0
    fi
    exit 2
    ;;
  stop)
    printf 'stop %s\n' "$*" >>"$log"
    exit 0
    ;;
  ps)
    if printf '%s\n' "$*" | grep -q -- '--status running'; then
      printf '%s-id\n' "${@: -1}"
    else
      printf 'healthy synthetic services\n'
    fi
    exit 0
    ;;
esac
exit 2
EOF

cat >"$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [ "${FAKE_ASSERT_RECEIPT_DURING_HEALTH:-}" = 1 ]; then
  root="${FAKE_UPDATE_ROOT:?}"
  log="${FAKE_UPDATE_LOG:?}"
  [ -f "$root/.nyxdoc-update-state" ]
  image="$(awk -F= '$1 == "NYXDOC_IMAGE" { print substr($0, index($0, "=") + 1); exit }' \
    "$root/.env.production")"
  printf 'health image=%s receipt=present\n' "$image" >>"$log"
fi
exit 0
EOF
chmod 0755 "$fake_bin/docker" "$fake_bin/curl"

prepare_checkout() {
  local name="$1"
  local image="$2"
  local revision="${3:-v0.25.18}"
  local checkout="$temporary/$name"
  git -c core.autocrlf=false clone "$origin" "$checkout" >/dev/null
  git -C "$checkout" checkout --detach "$revision" >/dev/null
  cp "$checkout/.env.production.example" "$checkout/.env.production"
  sed -i \
    -e "s#^NYXDOC_IMAGE=.*#NYXDOC_IMAGE=$image#" \
    -e 's#^NYXDOC_UPDATE_AUTHORITY=.*#NYXDOC_UPDATE_AUTHORITY=origin#' \
    -e 's#^BETTER_AUTH_SECRET=.*#BETTER_AUTH_SECRET=revision-test-auth-secret-0123456789-abcdefghijklmnopqrstuvwxyz#' \
    -e 's#^NYXDOC_COLLABORATION_SECRET=.*#NYXDOC_COLLABORATION_SECRET=revision-test-collaboration-secret-0123456789-abcdefgh#' \
    "$checkout/.env.production"
  printf '%s\n' "$checkout"
}

prepare_private_checkout() {
  local name="$1"
  local image="$2"
  local checkout="$temporary/$name"
  git -c core.autocrlf=false clone "$private_origin" "$checkout" >/dev/null
  cp "$checkout/.env.production.example" "$checkout/.env.production"
  sed -i \
    -e "s#^NYXDOC_IMAGE=.*#NYXDOC_IMAGE=$image#" \
    -e 's#^NYXDOC_UPDATE_AUTHORITY=.*#NYXDOC_UPDATE_AUTHORITY=official#' \
    -e 's#^BETTER_AUTH_SECRET=.*#BETTER_AUTH_SECRET=revision-test-auth-secret-0123456789-abcdefghijklmnopqrstuvwxyz#' \
    -e 's#^NYXDOC_COLLABORATION_SECRET=.*#NYXDOC_COLLABORATION_SECRET=revision-test-collaboration-secret-0123456789-abcdefgh#' \
    "$checkout/.env.production"
  printf '%s\n' "$checkout"
}

run_official_case() {
  local name="$1"
  local oci_revision="$2"
  local environment_revision="$3"
  local expected_status="$4"
  local expected_error="${5:-}"
  local checkout log output error
  checkout="$(prepare_checkout "$name" 'ghcr.io/getnyxdoc/nyxdoc:0.25.18')"
  log="$temporary/$name.log"
  output="$temporary/$name.out"
  error="$temporary/$name.err"
  : >"$log"

  if FAKE_UPDATE_ROOT="$checkout" \
    FAKE_UPDATE_LOG="$log" \
    FAKE_OCI_REVISION="$oci_revision" \
    FAKE_ENV_REVISION="$environment_revision" \
    NYXDOC_OFFICIAL_RELEASE_SOURCE="$origin" \
    PATH="$fake_bin:$PATH" \
    bash "$checkout/scripts/update.sh" >"$output" 2>"$error"; then
    status=success
  else
    status=failure
  fi
  [ "$status" = "$expected_status" ] || {
    printf '%s expected %s but got %s\n' "$name" "$expected_status" "$status" >&2
    cat "$output" "$error" >&2
    exit 1
  }

  if [ "$expected_status" = success ]; then
    # OCI label + target runtime revision, followed by an independent check of
    # the currently running image before its backup is attributed to this Git
    # checkout.
    [ "$(grep -c '^metadata ' "$log")" = 3 ]
    grep -Fq 'NYXDOC_IMAGE=ghcr.io/getnyxdoc/nyxdoc@sha256:' "$checkout/.env.production"
    grep -q '^up ' "$log"
  else
    grep -q "$expected_error" "$error"
    if grep -q '^up ' "$log"; then
      printf '%s started containers after provenance rejection\n' "$name" >&2
      exit 1
    fi
  fi
}

run_official_case official-history \
  "$target_revision" "$target_revision" success
run_official_case different-history \
  1111111111111111111111111111111111111111 \
  1111111111111111111111111111111111111111 \
  failure 'OCI revision does not match target checkout'
run_official_case missing-label \
  missing "$target_revision" \
  failure 'OCI revision does not match target checkout'
run_official_case missing-environment \
  "$target_revision" missing \
  failure 'must contain exactly one NYXDOC_SOURCE_REVISION'
run_official_case mismatched-environment \
  "$target_revision" 1111111111111111111111111111111111111111 \
  failure 'NYXDOC_SOURCE_REVISION does not match target checkout'

# The official stable stream is resolved from its dedicated public source, not
# from the checkout's unrelated private origin. The user's origin remains
# untouched while source, immutable digest, OCI label, and runtime revision all
# converge on the canonical GitHub commit.
unrelated_checkout="$(prepare_private_checkout unrelated-official 'ghcr.io/getnyxdoc/nyxdoc:0.25.17')"
unrelated_log="$temporary/unrelated-official.log"
: >"$unrelated_log"
NYXDOC_OFFICIAL_RELEASE_SOURCE="$origin" \
FAKE_UPDATE_ROOT="$unrelated_checkout" \
FAKE_UPDATE_LOG="$unrelated_log" \
FAKE_OCI_REVISION="$target_revision" \
FAKE_ENV_REVISION="$target_revision" \
PATH="$fake_bin:$PATH" \
bash "$unrelated_checkout/scripts/update.sh" \
  >"$temporary/unrelated-official.out" 2>"$temporary/unrelated-official.err"
[ "$(git -C "$unrelated_checkout" rev-parse HEAD)" = "$target_revision" ]
[ "$(git -C "$unrelated_checkout" remote get-url origin)" = "$private_origin" ]
grep -Fxq \
  'NYXDOC_IMAGE=ghcr.io/getnyxdoc/nyxdoc@sha256:0000000000000000000000000000000000000000000000000000000000000001' \
  "$unrelated_checkout/.env.production"
grep -Fq 'Switching to the explicitly selected canonical official release commit' \
  "$temporary/unrelated-official.out"

# Authority is a deployment decision, not a property inferred from the image.
# An explicit origin authority must never jump an unrelated private checkout to
# GitHub merely because the currently configured image happens to be official.
origin_authority_checkout="$(prepare_private_checkout explicit-origin-private 'ghcr.io/getnyxdoc/nyxdoc:0.25.17')"
sed -i 's#^NYXDOC_UPDATE_AUTHORITY=.*#NYXDOC_UPDATE_AUTHORITY=origin#' \
  "$origin_authority_checkout/.env.production"
origin_authority_log="$temporary/explicit-origin-private.log"
: >"$origin_authority_log"
if NYXDOC_OFFICIAL_RELEASE_SOURCE="$origin" \
  FAKE_UPDATE_ROOT="$origin_authority_checkout" \
  FAKE_UPDATE_LOG="$origin_authority_log" \
  FAKE_OCI_REVISION="$target_revision" \
  FAKE_ENV_REVISION="$target_revision" \
  PATH="$fake_bin:$PATH" \
  bash "$origin_authority_checkout/scripts/update.sh" \
    >"$temporary/explicit-origin-private.out" \
    2>"$temporary/explicit-origin-private.err"; then
  printf 'explicit origin authority unexpectedly crossed into the official release history\n' >&2
  exit 1
fi
[ "$(git -C "$origin_authority_checkout" rev-parse HEAD)" = "$(git -C "$private_seed" rev-parse HEAD)" ]
[ ! -s "$origin_authority_log" ]

# Pre-v0.25.18 installations have no authority setting. Retain their former
# official-image behavior once, then persist the resulting authority so later
# runs no longer infer it from the image.
legacy_authority_checkout="$(prepare_private_checkout legacy-authority 'ghcr.io/getnyxdoc/nyxdoc:0.25.17')"
sed -i '/^NYXDOC_UPDATE_AUTHORITY=/d' "$legacy_authority_checkout/.env.production"
legacy_authority_log="$temporary/legacy-authority.log"
: >"$legacy_authority_log"
NYXDOC_OFFICIAL_RELEASE_SOURCE="$origin" \
  FAKE_UPDATE_ROOT="$legacy_authority_checkout" \
  FAKE_UPDATE_LOG="$legacy_authority_log" \
  FAKE_OCI_REVISION="$target_revision" \
  FAKE_ENV_REVISION="$target_revision" \
  PATH="$fake_bin:$PATH" \
  bash "$legacy_authority_checkout/scripts/update.sh" \
    >"$temporary/legacy-authority.out" \
    2>"$temporary/legacy-authority.err"
[ "$(git -C "$legacy_authority_checkout" rev-parse HEAD)" = "$target_revision" ]
grep -Fxq 'NYXDOC_UPDATE_AUTHORITY=official' "$legacy_authority_checkout/.env.production"

run_third_party_advance_case() {
  local name="$1"
  local update_override="$2"
  local build_argument="$3"
  local expected_status="$4"
  local expected_error="${5:-}"
  local checkout log output error status
  local update_arguments=()
  checkout="$(prepare_checkout "$name" 'registry.example/nyxdoc@sha256:old' "$baseline_revision")"
  log="$temporary/$name.log"
  output="$temporary/$name.out"
  error="$temporary/$name.err"
  : >"$log"
  if [ -n "$build_argument" ]; then
    update_arguments=("$build_argument")
  fi

  if NYXDOC_UPDATE_IMAGE="$update_override" \
    FAKE_UPDATE_ROOT="$checkout" \
    FAKE_UPDATE_LOG="$log" \
    FAKE_OCI_REVISION="$target_revision" \
    FAKE_ENV_REVISION="$target_revision" \
    PATH="$fake_bin:$PATH" \
    bash "$checkout/scripts/update.sh" "${update_arguments[@]}" >"$output" 2>"$error"; then
    status=success
  else
    status=failure
  fi
  [ "$status" = "$expected_status" ] || {
    printf '%s expected %s but got %s\n' "$name" "$expected_status" "$status" >&2
    cat "$output" "$error" >&2
    exit 1
  }

  if [ "$expected_status" = failure ]; then
    grep -Fq "$expected_error" "$error"
    [ "$(git -C "$checkout" rev-parse HEAD)" = "$baseline_revision" ]
    if [ -s "$log" ]; then
      printf '%s invoked Docker before rejecting stale third-party image\n' "$name" >&2
      cat "$log" >&2
      exit 1
    fi
    return
  fi

  [ "$(git -C "$checkout" rev-parse HEAD)" = "$target_revision" ]
  grep -q '^up ' "$log"
}

# A source advance must never carry an unrelated registry image forward merely
# because it is digest-pinned. The caller must name the replacement image or
# opt into a local rebuild.
run_third_party_advance_case stale-third-party '' '' failure \
  'Advancing source requires NYXDOC_UPDATE_IMAGE=<new image> or --build'

# Mirrors remain supported when the caller explicitly makes that selection for
# this update. They are deliberately not subjected to official-GHCR labels.
run_third_party_advance_case explicit-third-party-mirror \
  'registry.example/nyxdoc@sha256:new' '' success
explicit_checkout="$temporary/explicit-third-party-mirror"
grep -Fq 'NYXDOC_IMAGE=registry.example/nyxdoc@sha256:new' "$explicit_checkout/.env.production"

# --build has the same explicitness and binds the rebuilt image to the checked
# out source revision rather than reusing the old third-party digest.
run_third_party_advance_case third-party-local-build '' '--build' success
local_advance_checkout="$temporary/third-party-local-build"
grep -Fq "build --build-arg SOURCE_REVISION=$target_revision" \
  "$temporary/third-party-local-build.log"
grep -Fq 'NYXDOC_IMAGE=nyxdoc-app:0.25.18' "$local_advance_checkout/.env.production"

# --build deliberately binds the candidate image to this checkout through
# SOURCE_REVISION and therefore remains valid for independent Forgejo/fork
# histories. The currently running local image is still checked through its
# baked runtime revision before the backup is attributed to this checkout; no
# official-image OCI label is consulted.
local_checkout="$(prepare_checkout local-build 'nyxdoc-app:0.25.18')"
local_log="$temporary/local-build.log"
: >"$local_log"
FAKE_UPDATE_ROOT="$local_checkout" \
FAKE_UPDATE_LOG="$local_log" \
FAKE_OCI_REVISION=1111111111111111111111111111111111111111 \
FAKE_ENV_REVISION=1111111111111111111111111111111111111111 \
PATH="$fake_bin:$PATH" \
bash "$local_checkout/scripts/update.sh" --channel main --build \
  >"$temporary/local-build.out" 2>"$temporary/local-build.err"
grep -Fq "build --build-arg SOURCE_REVISION=$target_revision" "$local_log"
grep -Fq 'NYXDOC_IMAGE=nyxdoc-app:0.25.18' "$local_checkout/.env.production"
if grep -q '^metadata oci ' "$local_log"; then
  printf 'local --build unexpectedly inspected an official-image OCI label\n' >&2
  exit 1
fi
grep -q '^metadata env ' "$local_log"

# A one-shot third-party image selection must survive an interruption after
# source checkout. The retry deliberately omits NYXDOC_UPDATE_IMAGE and must
# start the exact digest from the durable receipt, retaining that receipt until
# all health checks have converged.
real_git="$(command -v git)"
cat >"$fake_bin/git" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

if "${FAKE_REAL_GIT:?}" "$@"; then
  status=0
else
  status=$?
fi
[ "$status" -eq 0 ] || exit "$status"

if [ "${1:-}" = -C ] \
  && [ "${3:-}" = checkout ] \
  && [ "${4:-}" = --detach ] \
  && [ "${5:-}" = "${FAKE_FAIL_AFTER_CHECKOUT_REVISION:-}" ] \
  && [ -f "${FAKE_FAIL_AFTER_CHECKOUT_MARKER:-/nonexistent}" ]; then
  rm -f -- "$FAKE_FAIL_AFTER_CHECKOUT_MARKER"
  exit 73
fi
EOF
chmod 0755 "$fake_bin/git"

# The canonical official target and its immutable image digest also survive a
# crash after an unrelated private checkout has moved to the GitHub commit.
# The retry must not consult or rewrite the private origin and must use the
# exact digest already recorded beside the verified backup.
official_interrupted_checkout="$(prepare_private_checkout interrupted-unrelated-official 'ghcr.io/getnyxdoc/nyxdoc:0.25.17')"
official_previous_revision="$(git -C "$official_interrupted_checkout" rev-parse HEAD)"
official_interrupted_log="$temporary/interrupted-unrelated-official.log"
official_checkout_failure_marker="$temporary/fail-after-official-checkout"
: >"$official_interrupted_log"
touch "$official_checkout_failure_marker"

if NYXDOC_OFFICIAL_RELEASE_SOURCE="$origin" \
  FAKE_REAL_GIT="$real_git" \
  FAKE_FAIL_AFTER_CHECKOUT_REVISION="$target_revision" \
  FAKE_FAIL_AFTER_CHECKOUT_MARKER="$official_checkout_failure_marker" \
  FAKE_UPDATE_ROOT="$official_interrupted_checkout" \
  FAKE_UPDATE_LOG="$official_interrupted_log" \
  FAKE_OCI_REVISION="$target_revision" \
  FAKE_ENV_REVISION="$target_revision" \
  PATH="$fake_bin:$PATH" \
  bash "$official_interrupted_checkout/scripts/update.sh" \
    >"$temporary/interrupted-unrelated-official-first.out" \
    2>"$temporary/interrupted-unrelated-official-first.err"; then
  printf 'injected official post-checkout interruption unexpectedly succeeded\n' >&2
  exit 1
fi
[ "$(git -C "$official_interrupted_checkout" rev-parse HEAD)" = "$target_revision" ]
[ "$(git -C "$official_interrupted_checkout" remote get-url origin)" = "$private_origin" ]
[ ! -e "$official_checkout_failure_marker" ]
grep -Fxq \
  'targetImage=ghcr.io/getnyxdoc/nyxdoc@sha256:0000000000000000000000000000000000000000000000000000000000000001' \
  "$official_interrupted_checkout/.nyxdoc-update-state"
grep -Fxq 'format=nyxdoc-update-state/v3' \
  "$official_interrupted_checkout/.nyxdoc-update-state"
grep -Fxq 'updateAuthority=official' \
  "$official_interrupted_checkout/.nyxdoc-update-state"
grep -Fxq "previousRevision=$official_previous_revision" \
  "$official_interrupted_checkout/.nyxdoc-update-state"
grep -Fxq "backupSourceRevision=$official_previous_revision" \
  "$official_interrupted_checkout/.nyxdoc-update-state"
grep -Fxq 'previousConfiguredImage=ghcr.io/getnyxdoc/nyxdoc:0.25.17' \
  "$official_interrupted_checkout/.nyxdoc-update-state"
grep -Fxq 'previousRunningImageId=sha256:official-image' \
  "$official_interrupted_checkout/.nyxdoc-update-state"
grep -Fxq 'previousRunningImageDigest=unavailable' \
  "$official_interrupted_checkout/.nyxdoc-update-state"
grep -Fxq 'NYXDOC_IMAGE=ghcr.io/getnyxdoc/nyxdoc:0.25.17' \
  "$official_interrupted_checkout/.env.production"
grep -Fxq 'NYXDOC_UPDATE_AUTHORITY=official' \
  "$official_interrupted_checkout/.env.production"

# A receipt is not permission to overwrite an operator's later image change.
# Recovery must stop before another pull/build/container action, then resume
# exactly after that configuration is restored.
sed -i 's#^NYXDOC_IMAGE=.*#NYXDOC_IMAGE=registry.example/nyxdoc@sha256:tampered#' \
  "$official_interrupted_checkout/.env.production"
log_lines_before="$(wc -l <"$official_interrupted_log")"
if NYXDOC_OFFICIAL_RELEASE_SOURCE="$origin" \
  FAKE_REAL_GIT="$real_git" \
  FAKE_UPDATE_ROOT="$official_interrupted_checkout" \
  FAKE_UPDATE_LOG="$official_interrupted_log" \
  FAKE_OCI_REVISION="$target_revision" \
  FAKE_ENV_REVISION="$target_revision" \
  PATH="$fake_bin:$PATH" \
  bash "$official_interrupted_checkout/scripts/update.sh" \
    >"$temporary/interrupted-unrelated-official-tampered.out" \
    2>"$temporary/interrupted-unrelated-official-tampered.err"; then
  printf 'tampered interrupted configuration unexpectedly resumed\n' >&2
  exit 1
fi
grep -Fq 'does not match the current source, update authority, or configured image' \
  "$temporary/interrupted-unrelated-official-tampered.err"
[ "$(wc -l <"$official_interrupted_log")" = "$log_lines_before" ]
sed -i 's#^NYXDOC_IMAGE=.*#NYXDOC_IMAGE=ghcr.io/getnyxdoc/nyxdoc:0.25.17#' \
  "$official_interrupted_checkout/.env.production"

NYXDOC_OFFICIAL_RELEASE_SOURCE="$origin" \
FAKE_REAL_GIT="$real_git" \
FAKE_ASSERT_RECEIPT_DURING_HEALTH=1 \
FAKE_UPDATE_ROOT="$official_interrupted_checkout" \
FAKE_UPDATE_LOG="$official_interrupted_log" \
FAKE_OCI_REVISION="$target_revision" \
FAKE_ENV_REVISION="$target_revision" \
PATH="$fake_bin:$PATH" \
bash "$official_interrupted_checkout/scripts/update.sh" \
  >"$temporary/interrupted-unrelated-official-retry.out" \
  2>"$temporary/interrupted-unrelated-official-retry.err"
grep -Fq \
  'up -d --no-build --remove-orphans image=ghcr.io/getnyxdoc/nyxdoc@sha256:0000000000000000000000000000000000000000000000000000000000000001 receipt=present' \
  "$official_interrupted_log"
grep -Fxq \
  'NYXDOC_IMAGE=ghcr.io/getnyxdoc/nyxdoc@sha256:0000000000000000000000000000000000000000000000000000000000000001' \
  "$official_interrupted_checkout/.env.production"
[ ! -e "$official_interrupted_checkout/.nyxdoc-update-state" ]
[ "$(git -C "$official_interrupted_checkout" remote get-url origin)" = "$private_origin" ]

digest_a='registry.example/nyxdoc@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
digest_b='registry.example/nyxdoc@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
interrupted_checkout="$(prepare_checkout interrupted-third-party "$digest_a" "$baseline_revision")"
interrupted_log="$temporary/interrupted-third-party.log"
checkout_failure_marker="$temporary/fail-after-checkout"
: >"$interrupted_log"
touch "$checkout_failure_marker"

if NYXDOC_UPDATE_IMAGE="$digest_b" \
  FAKE_REAL_GIT="$real_git" \
  FAKE_FAIL_AFTER_CHECKOUT_REVISION="$target_revision" \
  FAKE_FAIL_AFTER_CHECKOUT_MARKER="$checkout_failure_marker" \
  FAKE_UPDATE_ROOT="$interrupted_checkout" \
  FAKE_UPDATE_LOG="$interrupted_log" \
  PATH="$fake_bin:$PATH" \
  bash "$interrupted_checkout/scripts/update.sh" \
    >"$temporary/interrupted-third-party-first.out" \
    2>"$temporary/interrupted-third-party-first.err"; then
  printf 'injected post-checkout interruption unexpectedly succeeded\n' >&2
  exit 1
fi
[ "$(git -C "$interrupted_checkout" rev-parse HEAD)" = "$target_revision" ]
[ ! -e "$checkout_failure_marker" ]
grep -Fxq "targetImage=$digest_b" "$interrupted_checkout/.nyxdoc-update-state"
grep -Fxq 'updateAuthority=origin' "$interrupted_checkout/.nyxdoc-update-state"
grep -Fxq "backupSourceRevision=$baseline_revision" "$interrupted_checkout/.nyxdoc-update-state"
grep -Fxq "NYXDOC_IMAGE=$digest_a" "$interrupted_checkout/.env.production"
if grep -q '^up ' "$interrupted_log"; then
  printf 'interrupted update started containers after the injected checkout failure\n' >&2
  exit 1
fi

FAKE_REAL_GIT="$real_git" \
FAKE_ASSERT_RECEIPT_DURING_HEALTH=1 \
FAKE_UPDATE_ROOT="$interrupted_checkout" \
FAKE_UPDATE_LOG="$interrupted_log" \
PATH="$fake_bin:$PATH" \
bash "$interrupted_checkout/scripts/update.sh" \
  >"$temporary/interrupted-third-party-retry.out" \
  2>"$temporary/interrupted-third-party-retry.err"
grep -Fq "up -d --no-build --remove-orphans image=$digest_b receipt=present" \
  "$interrupted_log"
grep -Fq "health image=$digest_b receipt=present" "$interrupted_log"
grep -Fxq "NYXDOC_IMAGE=$digest_b" "$interrupted_checkout/.env.production"
[ ! -e "$interrupted_checkout/.nyxdoc-update-state" ]

printf 'Official update image revision and local --build boundaries passed.\n'
