#!/usr/bin/env bash

# Qualify one immutable release candidate image on a disposable GitHub runner.
# This script deliberately never assigns a public semver/latest tag. Promotion is
# a separate workflow job and is allowed only after its receipt is verified.

set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/release-qualification.sh \
    --candidate-image ghcr.io/getnyxdoc/nyxdoc@sha256:<digest> \
    --candidate-revision <40-character-git-sha> \
    --baseline-ref v0.24.1 \
    --baseline-image ghcr.io/getnyxdoc/nyxdoc:0.24.1 \
    --receipt <path>

Runs fresh-install, preserve/reinstall, and historical-upgrade qualification
against the exact candidate manifest digest. The result is a portable JSON
receipt for the separate promotion job.
EOF
}

candidate_image=""
candidate_revision=""
baseline_ref=""
baseline_image=""
receipt_path=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --candidate-image) candidate_image="${2:-}"; shift 2 ;;
    --candidate-revision) candidate_revision="${2:-}"; shift 2 ;;
    --baseline-ref) baseline_ref="${2:-}"; shift 2 ;;
    --baseline-image) baseline_image="${2:-}"; shift 2 ;;
    --receipt) receipt_path="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; printf '[nyxdoc] error: unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done

fail() {
  printf '[nyxdoc] release qualification failed: %s\n' "$*" >&2
  if [ -n "${qualification_log:-}" ]; then
    printf '[nyxdoc] release qualification failed: %s\n' "$*" >>"$qualification_log"
  fi
  exit 1
}

require_argument() {
  [ -n "$2" ] || fail "missing $1"
}

require_argument --candidate-image "$candidate_image"
require_argument --candidate-revision "$candidate_revision"
require_argument --baseline-ref "$baseline_ref"
require_argument --baseline-image "$baseline_image"
require_argument --receipt "$receipt_path"

qualification_artifact_dir="$(dirname -- "$receipt_path")"
mkdir -p "$qualification_artifact_dir"
qualification_log="$qualification_artifact_dir/qualification.log"
printf '[nyxdoc] release qualification started for %s\n' "$candidate_image" >"$qualification_log"

case "$candidate_image" in
  *@sha256:*) ;;
  *) fail "candidate image must be an immutable image@sha256 digest reference" ;;
esac
candidate_digest="${candidate_image##*@}"
[[ "$candidate_digest" =~ ^sha256:[a-f0-9]{64}$ ]] \
  || fail "candidate digest is malformed"
[[ "$candidate_revision" =~ ^[0-9a-f]{40}$ ]] \
  || fail "candidate revision must be a 40-character lowercase Git SHA"

command -v docker >/dev/null 2>&1 || fail "docker is required"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
docker buildx version >/dev/null 2>&1 || fail "Docker Buildx is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v git >/dev/null 2>&1 || fail "git is required"
command -v node >/dev/null 2>&1 || fail "node is required"
command -v npx >/dev/null 2>&1 || fail "npx is required for the browser boundary test"

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
git -C "$root" diff --quiet || fail "qualification requires a clean tracked checkout"
git -C "$root" diff --cached --quiet || fail "qualification requires a clean staged checkout"
git -C "$root" rev-parse --verify "${candidate_revision}^{commit}" >/dev/null \
  || fail "candidate revision is not available in this checkout"
git -C "$root" rev-parse --verify "${baseline_ref}^{commit}" >/dev/null \
  || fail "historical baseline ref is not available in this checkout"

if [ "$(git -C "$root" rev-parse "${candidate_revision}^{commit}")" != "$candidate_revision" ]; then
  fail "candidate revision did not resolve exactly"
fi

inspect_manifest_digest() {
  local reference="$1"
  local expected="$2"
  local inspection=""
  local observed=""
  local attempt

  for attempt in $(seq 1 12); do
    if inspection="$(docker buildx imagetools inspect "$reference" 2>&1)"; then
      observed="$(printf '%s\n' "$inspection" | awk '$1 == "Digest:" { print $2; exit }')"
      if [ "$observed" = "$expected" ]; then
        printf '%s\n' "$observed"
        return 0
      fi
    fi
    printf '[nyxdoc] candidate digest not visible yet (attempt %s/12, observed %s)\n' \
      "$attempt" "${observed:-none}" | tee -a "$qualification_log" >&2
    sleep 10
  done
  return 1
}

manifest_digest="$(inspect_manifest_digest "$candidate_image" "$candidate_digest")" \
  || fail "registry manifest digest provenance is missing or differs from the candidate digest"

pull_succeeded=false
for attempt in $(seq 1 12); do
  if pull_output="$(docker pull "$candidate_image" 2>&1)"; then
    printf '%s\n' "$pull_output" >>"$qualification_log"
    pull_succeeded=true
    break
  fi
  printf '[nyxdoc] candidate image pull not ready yet (attempt %s/12)\n' "$attempt" \
    | tee -a "$qualification_log" >&2
  printf '%s\n' "$pull_output" >>"$qualification_log"
  sleep 10
done
$pull_succeeded || fail "candidate image could not be pulled after registry propagation retries"

temporary="$(mktemp -d "${TMPDIR:-/tmp}/nyxdoc-release-qualification.XXXXXX")"
run_id="$(date +%s)-$RANDOM"
fresh_dir="$temporary/fresh"
upgrade_dir="$temporary/upgrade"
artifact_dir="$temporary/artifacts"
mkdir -p "$artifact_dir"
browser_evidence_dir="$(dirname -- "$receipt_path")/playwright"

fresh_port="${NYXDOC_RELEASE_QUALIFICATION_HTTP_PORT:-$((38000 + RANDOM % 1000))}"
fresh_collaboration_port="$((fresh_port + 1000))"
upgrade_port="$((fresh_port + 2000))"
upgrade_collaboration_port="$((fresh_port + 3000))"

declare -A checks=()
baseline_schema=""
candidate_schema=""

compose_for() {
  local directory="$1"
  docker compose --project-directory "$directory" \
    --env-file "$directory/.env.production" \
    -f "$directory/compose.yaml" "$@"
}

set_env() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  local replacement
  replacement="$(mktemp "${env_file}.tmp.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    index($0, key "=") == 1 { print key "=" value; replaced = 1; next }
    { print }
    END { if (!replaced) print key "=" value }
  ' "$env_file" >"$replacement"
  chmod 600 "$replacement"
  mv "$replacement" "$env_file"
}

prepare_environment() {
  local directory="$1"
  local image="$2"
  local http_port="$3"
  local collaboration_port="$4"
  local volume="$5"
  local backup_path="$6"
  cp "$directory/.env.production.example" "$directory/.env.production"
  chmod 600 "$directory/.env.production"
  set_env "$directory/.env.production" NYXDOC_IMAGE "$image"
  set_env "$directory/.env.production" NYXDOC_HTTP_HOST "127.0.0.1"
  set_env "$directory/.env.production" NYXDOC_HTTP_PORT "$http_port"
  set_env "$directory/.env.production" NYXDOC_COLLABORATION_HOST_PORT "$collaboration_port"
  set_env "$directory/.env.production" NYXDOC_COLLABORATION_PUBLIC_URL "ws://127.0.0.1:${http_port}/collaboration"
  set_env "$directory/.env.production" NYXDOC_DATA_VOLUME "$volume"
  set_env "$directory/.env.production" NYXDOC_BACKUP_HOST_PATH "$backup_path"
  set_env "$directory/.env.production" BETTER_AUTH_URL "http://127.0.0.1:${http_port}"
  set_env "$directory/.env.production" AUTH_TRUSTED_ORIGINS "http://127.0.0.1:${http_port}"
  set_env "$directory/.env.production" BETTER_AUTH_SECRET "release-qualification-auth-secret-0123456789-abcdefghijklmnopqrstuvwxyz"
  set_env "$directory/.env.production" NYXDOC_COLLABORATION_SECRET "release-qualification-collaboration-secret-0123456789-abcdefghijkl"
  set_env "$directory/.env.production" REGISTRATION_MODE "open"
}

verify_service_image() {
  local directory="$1"
  local expected_image="$2"
  local images
  images="$(compose_for "$directory" config --images | sort -u)"
  [ "$images" = "$expected_image" ] \
    || fail "Compose service image provenance differs from expected immutable candidate: ${images:-none}"
}

wait_for_services() {
  local label="$1"
  local http_port="$2"
  local collaboration_port="$3"
  for _ in $(seq 1 60); do
    if curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${http_port}/api/health" >/dev/null \
      && curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${collaboration_port}/health" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  compose_for "$label" ps >&2 || true
  compose_for "$label" logs --tail 120 app collaboration gateway >&2 || true
  fail "${label} services did not become healthy"
}

database_integrity() {
  local directory="$1"
  compose_for "$directory" exec -T app node - <<'NODE'
const Database = require("better-sqlite3");
const database = new Database(process.env.NYXDOC_DB_PATH);
const integrity = database.pragma("integrity_check", { simple: true });
const userVersion = database.pragma("user_version", { simple: true });
const rows = Object.fromEntries([
  "user",
  "workspaces",
  "workspace_members",
  "documents",
  "document_revisions",
  "media_assets",
].map((table) => [table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
database.close();
if (integrity !== "ok") {
  console.error(`SQLite integrity_check failed: ${integrity}`);
  process.exit(1);
}
console.log(JSON.stringify({ integrity, userVersion, rows }));
NODE
}

assert_historical_data_preserved() {
  local before="$1"
  local after="$2"
  node - "$before" "$after" <<'NODE'
const [beforeRaw, afterRaw] = process.argv.slice(2);
const before = JSON.parse(beforeRaw);
const after = JSON.parse(afterRaw);
for (const [table, count] of Object.entries(before.rows)) {
  if ((after.rows?.[table] ?? -1) < count) {
    throw new Error(`historical ${table} row count decreased (${count} -> ${after.rows?.[table] ?? "missing"})`);
  }
}
if ((after.rows?.user ?? 0) < 1 || (after.rows?.workspaces ?? 0) < 1) {
  throw new Error("historical authenticated workspace data is missing after upgrade");
}
console.log(JSON.stringify({ status: "passed", before: before.rows, after: after.rows }));
NODE
}

run_mcp_http() {
  local directory="$1"
  compose_for "$directory" exec -T -e NYXDOC_TEST_BASE_URL=http://gateway:3002 app npm run test:mcp-http
}

run_browser_vertical() {
  local label="$1"
  local http_port="$2"
  local existing_email="${3:-}"
  mkdir -p "$browser_evidence_dir/$label"
  (
    cd "$root"
    PLAYWRIGHT_EXTERNAL_SERVER=1 \
      PLAYWRIGHT_BASE_URL="http://127.0.0.1:${http_port}" \
      PLAYWRIGHT_COLLABORATION_PATH="/collaboration" \
      PLAYWRIGHT_OUTPUT_DIR="$browser_evidence_dir/$label/results" \
      PLAYWRIGHT_EXISTING_EMAIL="$existing_email" \
      PLAYWRIGHT_EXISTING_PASSWORD="Release-qualification-password-123!" \
      npx playwright test e2e/vertical --project=chromium
  ) 2>&1 | tee "$browser_evidence_dir/$label/release-candidate.log"
}

create_authenticated_workspace() {
  local directory="$1"
  local http_port="$2"
  local email="${3:-release-qualification-$(date +%s)-$RANDOM@example.test}"
  node - "$http_port" "$email" <<'NODE'
(async () => {
  const [httpPort, email] = process.argv.slice(2);
  const baseUrl = `http://127.0.0.1:${httpPort}`;
  const response = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({
      name: "Release Qualification",
      email,
      password: "Release-qualification-password-123!",
    }),
    redirect: "manual",
  });
  if (response.status !== 200) {
    throw new Error(`sign-up did not create a session (${response.status}): ${await response.text()}`);
  }
  const setCookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie")];
  const cookie = setCookies.filter(Boolean).map((value) => value.split(";", 1)[0]).join("; ");
  if (!cookie) throw new Error("sign-up did not return a session cookie");
  const session = await fetch(`${baseUrl}/api/auth/get-session`, { headers: { cookie } });
  if (!session.ok) throw new Error(`session verification failed (${session.status})`);
  console.log(JSON.stringify({ status: "passed", authenticatedEmail: email }));
})().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
NODE
}

cleanup_directory() {
  local directory="$1"
  [ -f "$directory/.env.production" ] || return 0
  compose_for "$directory" down --volumes --remove-orphans >/dev/null 2>&1 || true
}

cleanup() {
  cleanup_directory "$fresh_dir"
  cleanup_directory "$upgrade_dir"
  git -C "$root" worktree remove --force "$fresh_dir" >/dev/null 2>&1 || true
  git -C "$root" worktree remove --force "$upgrade_dir" >/dev/null 2>&1 || true
  rm -rf "$temporary"
}
trap cleanup EXIT

git -C "$root" worktree add --detach "$fresh_dir" "$candidate_revision" >/dev/null
git -C "$root" worktree add --detach "$upgrade_dir" "$baseline_ref" >/dev/null

fresh_volume="nyxdoc_release_${run_id}_fresh"
fresh_backup="$artifact_dir/fresh-backups"
prepare_environment "$fresh_dir" "$candidate_image" "$fresh_port" "$fresh_collaboration_port" "$fresh_volume" "$fresh_backup"
(cd "$fresh_dir" && ./scripts/install.sh)
verify_service_image "$fresh_dir" "$candidate_image"
wait_for_services "$fresh_dir" "$fresh_port" "$fresh_collaboration_port"
checks["fresh-install"]="passed"
checks["fresh-http-health"]="passed"
run_browser_vertical "fresh" "$fresh_port"
checks["fresh-browser-session"]="passed"
checks["fresh-collaboration-websocket"]="passed"
create_authenticated_workspace "$fresh_dir" "$fresh_port"
checks["fresh-auth-session"]="passed"
run_mcp_http "$fresh_dir"
checks["fresh-mcp-http"]="passed"
(cd "$fresh_dir" && ./scripts/uninstall.sh)
docker volume inspect "$fresh_volume" >/dev/null || fail "normal uninstall did not preserve the fresh-install data volume"
(cd "$fresh_dir" && ./scripts/install.sh)
verify_service_image "$fresh_dir" "$candidate_image"
wait_for_services "$fresh_dir" "$fresh_port" "$fresh_collaboration_port"
checks["fresh-reinstall"]="passed"
cleanup_directory "$fresh_dir"

upgrade_volume="nyxdoc_release_${run_id}_upgrade"
upgrade_backup="$artifact_dir/upgrade-backups"
prepare_environment "$upgrade_dir" "$baseline_image" "$upgrade_port" "$upgrade_collaboration_port" "$upgrade_volume" "$upgrade_backup"
(cd "$upgrade_dir" && ./scripts/install.sh)
wait_for_services "$upgrade_dir" "$upgrade_port" "$upgrade_collaboration_port"
historical_email="release-upgrade-${run_id}@example.test"
create_authenticated_workspace "$upgrade_dir" "$upgrade_port" "$historical_email"
checks["historical-auth-session"]="passed"
baseline_schema="$(database_integrity "$upgrade_dir")"
checks["historical-install"]="passed"

set_env "$upgrade_dir/.env.production" NYXDOC_IMAGE "$candidate_image"
(cd "$upgrade_dir" && ./scripts/update.sh)
updated_revision="$(git -C "$upgrade_dir" rev-parse HEAD)"
[ "$updated_revision" = "$candidate_revision" ] \
  || fail "historical update checked out ${updated_revision}, not the release candidate revision"
verify_service_image "$upgrade_dir" "$candidate_image"
wait_for_services "$upgrade_dir" "$upgrade_port" "$upgrade_collaboration_port"
checks["historical-upgrade"]="passed"
checks["historical-http-health"]="passed"
candidate_schema="$(database_integrity "$upgrade_dir")"
checks["historical-database-integrity"]="passed"
assert_historical_data_preserved "$baseline_schema" "$candidate_schema"
checks["historical-data-preserved"]="passed"
run_browser_vertical "historical-upgrade" "$upgrade_port" "$historical_email"
checks["historical-browser-session"]="passed"
checks["historical-collaboration-websocket"]="passed"
run_mcp_http "$upgrade_dir"
checks["historical-mcp-http"]="passed"

checks["candidate-provenance"]="passed"
required_checks=(
  "candidate-provenance"
  "fresh-install"
  "fresh-auth-session"
  "fresh-http-health"
  "fresh-browser-session"
  "fresh-collaboration-websocket"
  "fresh-mcp-http"
  "fresh-reinstall"
  "historical-install"
  "historical-upgrade"
  "historical-auth-session"
  "historical-http-health"
  "historical-browser-session"
  "historical-collaboration-websocket"
  "historical-mcp-http"
  "historical-database-integrity"
  "historical-data-preserved"
)
for required_check in "${required_checks[@]}"; do
  [ "${checks[$required_check]:-}" = "passed" ] \
    || fail "required matrix evidence is absent for ${required_check}"
done
mkdir -p "$(dirname -- "$receipt_path")"
node - "$receipt_path" "$candidate_image" "$candidate_digest" "$candidate_revision" "$baseline_ref" "$baseline_image" "$baseline_schema" "$candidate_schema" <<'NODE'
const [receiptPath, image, digest, revision, baselineRef, baselineImage, baselineSchema, candidateSchema] = process.argv.slice(2);
const checks = Object.fromEntries([
  "candidate-provenance",
  "fresh-install",
  "fresh-auth-session",
  "fresh-http-health",
  "fresh-browser-session",
  "fresh-collaboration-websocket",
  "fresh-mcp-http",
  "fresh-reinstall",
  "historical-install",
  "historical-upgrade",
  "historical-auth-session",
  "historical-http-health",
  "historical-browser-session",
  "historical-collaboration-websocket",
  "historical-mcp-http",
  "historical-database-integrity",
  "historical-data-preserved",
].map((id) => [id, { status: "passed" }]));
require("node:fs").writeFileSync(receiptPath, `${JSON.stringify({
  format: "nyxdoc-release-qualification/v1",
  generatedAt: new Date().toISOString(),
  candidate: { image, digest, revision },
  baseline: { ref: baselineRef, image: baselineImage },
  checks,
  database: {
    baseline: JSON.parse(baselineSchema),
    candidate: JSON.parse(candidateSchema),
  },
}, null, 2)}\n`);
NODE

node "$root/scripts/verify-release-qualification-receipt.mjs" \
  --receipt "$receipt_path" \
  --candidate-image "$candidate_image" \
  --candidate-revision "$candidate_revision"
printf '[nyxdoc] release qualification passed for %s\n' "$candidate_image"
