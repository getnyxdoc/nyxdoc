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

For a non-destructive registry provenance check only, add --preflight-only.

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
preflight_only=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --candidate-image) candidate_image="${2:-}"; shift 2 ;;
    --candidate-revision) candidate_revision="${2:-}"; shift 2 ;;
    --baseline-ref) baseline_ref="${2:-}"; shift 2 ;;
    --baseline-image) baseline_image="${2:-}"; shift 2 ;;
    --receipt) receipt_path="${2:-}"; shift 2 ;;
    --preflight-only) preflight_only=true; shift ;;
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

log_retry() {
  local message="$1"
  printf '%s\n' "$message" >&2
  [ -z "${qualification_log:-}" ] || printf '%s\n' "$message" >>"$qualification_log"
}

require_argument --candidate-image "$candidate_image"
require_argument --candidate-revision "$candidate_revision"
require_argument --baseline-ref "$baseline_ref"
require_argument --baseline-image "$baseline_image"
if ! $preflight_only; then
  require_argument --receipt "$receipt_path"
  qualification_artifact_dir="$(dirname -- "$receipt_path")"
  mkdir -p "$qualification_artifact_dir"
  qualification_log="$qualification_artifact_dir/qualification.log"
  printf '[nyxdoc] release qualification started for %s\n' "$candidate_image" >"$qualification_log"
else
  qualification_log=""
fi

case "$candidate_image" in
  *@sha256:*) ;;
  *) fail "candidate image must be an immutable image@sha256 digest reference" ;;
esac
candidate_digest="${candidate_image##*@}"
[[ "$candidate_digest" =~ ^sha256:[a-f0-9]{64}$ ]] \
  || fail "candidate digest is malformed"
[[ "$candidate_revision" =~ ^[0-9a-f]{40}$ ]] \
  || fail "candidate revision must be a 40-character lowercase Git SHA"

registry_retry_attempts="${NYXDOC_RELEASE_QUALIFICATION_REGISTRY_RETRY_ATTEMPTS:-12}"
registry_retry_delay_seconds="${NYXDOC_RELEASE_QUALIFICATION_REGISTRY_RETRY_DELAY_SECONDS:-10}"
[[ "$registry_retry_attempts" =~ ^[1-9][0-9]*$ ]] \
  || fail "NYXDOC_RELEASE_QUALIFICATION_REGISTRY_RETRY_ATTEMPTS must be a positive integer"
[[ "$registry_retry_delay_seconds" =~ ^[0-9]+$ ]] \
  || fail "NYXDOC_RELEASE_QUALIFICATION_REGISTRY_RETRY_DELAY_SECONDS must be a non-negative integer"

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
baseline_revision="$(git -C "$root" rev-parse "${baseline_ref}^{commit}")"

inspect_manifest_digest() {
  local reference="$1"
  local expected="$2"
  local inspection=""
  local observed=""
  local attempt

  for attempt in $(seq 1 "$registry_retry_attempts"); do
    if inspection="$(docker buildx imagetools inspect "$reference" 2>&1)"; then
      observed="$(printf '%s\n' "$inspection" | awk '$1 == "Digest:" { print $2; exit }')"
      if [[ "$observed" =~ ^sha256:[a-f0-9]{64}$ ]] \
        && { [ -z "$expected" ] || [ "$observed" = "$expected" ]; }; then
        printf '%s\n' "$observed"
        return 0
      fi
    fi
    log_retry "[nyxdoc] candidate digest not visible yet (attempt ${attempt}/${registry_retry_attempts}, observed ${observed:-none})"
    sleep "$registry_retry_delay_seconds"
  done
  return 1
}

inspect_manifest_digest "$candidate_image" "$candidate_digest" >/dev/null \
  || fail "registry manifest digest provenance is missing or differs from the candidate digest"
baseline_digest="$(inspect_manifest_digest "$baseline_image" "")" \
  || fail "baseline registry manifest digest provenance is missing"
baseline_immutable_image="${baseline_image%@*}@${baseline_digest}"

pull_image_with_retry() {
  local reference="$1"
  local image_kind="$2"
  local pull_output=""
  local attempt

  for attempt in $(seq 1 "$registry_retry_attempts"); do
    if pull_output="$(docker pull "$reference" 2>&1)"; then
      [ -z "$qualification_log" ] || printf '%s\n' "$pull_output" >>"$qualification_log"
      return 0
    fi
    log_retry "[nyxdoc] ${image_kind} image pull not ready yet (attempt ${attempt}/${registry_retry_attempts})"
    [ -z "$qualification_log" ] || printf '%s\n' "$pull_output" >>"$qualification_log"
    sleep "$registry_retry_delay_seconds"
  done
  return 1
}

verify_image_revision_provenance() {
  local reference="$1"
  local expected_revision="$2"
  local image_kind="$3"
  local oci_revision=""
  local environment=""
  local source_revision_count=""
  local source_revision=""

  oci_revision="$(docker image inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$reference" 2>/dev/null || true)"
  [ "$oci_revision" = "$expected_revision" ] \
    || fail "$image_kind image OCI revision label ${oci_revision:-missing} differs from ${expected_revision}"

  environment="$(docker image inspect \
    --format '{{ range .Config.Env }}{{ println . }}{{ end }}' \
    "$reference" 2>/dev/null || true)"
  source_revision_count="$(printf '%s\n' "$environment" | awk -F= \
    '$1 == "NYXDOC_SOURCE_REVISION" { count += 1 } END { print count + 0 }')"
  [ "$source_revision_count" = 1 ] \
    || fail "$image_kind image must contain exactly one NYXDOC_SOURCE_REVISION environment value (found ${source_revision_count})"
  source_revision="$(printf '%s\n' "$environment" | awk -F= \
    '$1 == "NYXDOC_SOURCE_REVISION" { print substr($0, index($0, "=") + 1); exit }')"
  [ "$source_revision" = "$expected_revision" ] \
    || fail "$image_kind image NYXDOC_SOURCE_REVISION environment ${source_revision:-missing} differs from ${expected_revision}"
}

pull_image_with_retry "$candidate_image" "candidate" \
  || fail "candidate image could not be pulled after registry propagation retries"
verify_image_revision_provenance "$candidate_image" "$candidate_revision" "candidate"

# A baseline tag is meaningful only when its OCI revision label and runtime
# NYXDOC_SOURCE_REVISION identify the exact Git commit selected for the
# historical migration rehearsal. Otherwise a retagged or stale baseline could
# make the upgrade result meaningless.
pull_image_with_retry "$baseline_image" "baseline" \
  || fail "baseline image could not be pulled after registry propagation retries"
verify_image_revision_provenance "$baseline_image" "$baseline_revision" "baseline"

if $preflight_only; then
  printf '[nyxdoc] release image provenance preflight passed\n'
  exit 0
fi

temporary="$(mktemp -d "${TMPDIR:-/tmp}/nyxdoc-release-qualification.XXXXXX")"
run_id="$(date +%s)-$RANDOM"
fresh_dir="$temporary/fresh"
upgrade_dir="$temporary/upgrade"
restore_dir="$temporary/restore"
update_origin="$temporary/update-origin.git"
artifact_dir="$temporary/artifacts"
mkdir -p "$artifact_dir"
browser_evidence_dir="$(dirname -- "$receipt_path")/playwright"
historical_fixture_driver="$root/scripts/test-fixtures/release-qualification-historical.ts"
historical_fixture_container_root="/tmp/nyxdoc-release-qualification"
historical_fixture_container_path="${historical_fixture_container_root}/scripts/test-fixtures/release-qualification-historical.ts"
historical_fixture_state="$temporary/historical-fixture-state.json"

fresh_port="${NYXDOC_RELEASE_QUALIFICATION_HTTP_PORT:-$((38000 + RANDOM % 1000))}"
upgrade_port="$((fresh_port + 2000))"
restore_port="$((fresh_port + 4000))"

declare -A checks=()
baseline_schema=""
candidate_schema=""
baseline_fixture_evidence=""
candidate_dirty_evidence=""
candidate_committed_evidence=""
reinstall_fixture_evidence=""
restore_fixture_evidence=""
backup_generation_id=""
backup_generation_path=""
backup_database_sha256=""
backup_media_tree_sha256=""
backup_media_files=""
backup_media_bytes=""
restore_status=""
historical_websocket_holder_pid=""
historical_drain_observer_pid=""

compose_for() {
  local directory="$1"
  shift
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
  local volume="$4"
  local backup_path="$5"
  cp "$directory/.env.production.example" "$directory/.env.production"
  chmod 600 "$directory/.env.production"
  set_env "$directory/.env.production" NYXDOC_IMAGE "$image"
  set_env "$directory/.env.production" NYXDOC_HTTP_HOST "127.0.0.1"
  set_env "$directory/.env.production" NYXDOC_HTTP_PORT "$http_port"
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
  for _ in $(seq 1 60); do
    if curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${http_port}/api/health" >/dev/null \
      && compose_for "$label" exec -T collaboration node -e '
        fetch("http://127.0.0.1:3101/health")
          .then((response) => process.exit(response.ok ? 0 : 1))
          .catch(() => process.exit(1));
      ' >/dev/null 2>&1; then
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
  # The application process owns the SQLite database and WAL as `node`.
  # Compose exec otherwise defaults to the image's root user, which can leave
  # SQLite sidecar ownership inconsistent with the running application.
  compose_for "$directory" exec -T --user node \
    -e NYXDOC_TEST_BASE_URL=http://gateway:3002 app npm run test:mcp-http
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

install_historical_fixture_driver() {
  local directory="$1"
  [ -f "$historical_fixture_driver" ] \
    || fail "historical release fixture driver is missing"
  compose_for "$directory" exec -T --user node app sh -c '
    set -eu
    mkdir -p /tmp/nyxdoc-release-qualification/scripts/test-fixtures
    ln -sfn /app/src /tmp/nyxdoc-release-qualification/src
    ln -sfn /app/node_modules /tmp/nyxdoc-release-qualification/node_modules
  '
  compose_for "$directory" cp \
    "$historical_fixture_driver" "app:${historical_fixture_container_path}"
}

create_historical_fixture() {
  local directory="$1"
  local email="$2"
  local state_path="$3"
  install_historical_fixture_driver "$directory"
  compose_for "$directory" exec -T --user node \
    -e NYXDOC_TEST_BASE_URL=http://gateway:3002 \
    app ./node_modules/.bin/tsx \
    "$historical_fixture_container_path" create "$email" >"$state_path"
  chmod 600 "$state_path"
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$state_path" \
    || fail "historical fixture state was not valid JSON"
}

verify_historical_fixture() {
  local directory="$1"
  local state_path="$2"
  local stage="$3"
  local evidence_path="$4"
  install_historical_fixture_driver "$directory"
  compose_for "$directory" exec -T --user node \
    -e NYXDOC_TEST_BASE_URL=http://gateway:3002 \
    app ./node_modules/.bin/tsx \
    "$historical_fixture_container_path" verify "$stage" \
    <"$state_path" | tee "$evidence_path" >>"$qualification_log"
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$evidence_path" \
    || fail "historical fixture evidence for ${stage} was not valid JSON"
}

mutate_historical_fixture_websocket() {
  local directory="$1"
  local state_path="$2"
  local replacement
  replacement="$(mktemp "${state_path}.tmp.XXXXXX")"
  install_historical_fixture_driver "$directory"
  compose_for "$directory" exec -T --user node \
    -e NYXDOC_TEST_BASE_URL=http://gateway:3002 \
    app ./node_modules/.bin/tsx \
    "$historical_fixture_container_path" websocket-mutate \
    <"$state_path" >"$replacement"
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$replacement" \
    || fail "WebSocket-mutated historical fixture state was not valid JSON"
  chmod 600 "$replacement"
  mv "$replacement" "$state_path"
}

json_stage_exists() {
  local evidence_path="$1"
  local stage="$2"
  node - "$evidence_path" "$stage" <<'NODE'
const fs = require("node:fs");
const [file, stage] = process.argv.slice(2);
let source = "";
try {
  source = fs.readFileSync(file, "utf8");
} catch {
  process.exit(1);
}
for (const line of source.split(/\r?\n/u)) {
  if (!line.startsWith("{")) continue;
  try {
    if (JSON.parse(line).stage === stage) process.exit(0);
  } catch {
    // Non-JSON diagnostics are not evidence.
  }
}
process.exit(1);
NODE
}

wait_for_json_stage() {
  local evidence_path="$1"
  local stage="$2"
  local process_id="$3"
  local description="$4"
  local attempt
  for attempt in $(seq 1 600); do
    if json_stage_exists "$evidence_path" "$stage"; then return 0; fi
    kill -0 "$process_id" >/dev/null 2>&1 \
      || fail "$description exited before reporting ${stage} evidence"
    sleep 0.1
  done
  fail "$description did not report ${stage} evidence before timeout"
}

historical_collaboration_connections() {
  local directory="$1"
  compose_for "$directory" exec -T collaboration node -e '
    fetch("http://127.0.0.1:3101/health")
      .then(async (response) => {
        if (!response.ok) process.exit(1);
        const payload = await response.json();
        if (!Number.isSafeInteger(payload.connections) || payload.connections < 0) process.exit(1);
        console.log(payload.connections);
      })
      .catch(() => process.exit(1));
  ' 2>/dev/null | tr -d '\r' | tail -n 1
}

start_historical_fixture_websocket_hold() {
  local directory="$1"
  local state_path="$2"
  local lifecycle_path="$3"
  local replacement
  replacement="$(mktemp "${state_path}.held.XXXXXX")"
  : >"$lifecycle_path"
  chmod 600 "$replacement" "$lifecycle_path"
  install_historical_fixture_driver "$directory"
  compose_for "$directory" exec -T --user node \
    -e NYXDOC_TEST_BASE_URL=http://gateway:3002 \
    -e NYXDOC_TEST_WS_HOLD_TIMEOUT_MS=600000 \
    app ./node_modules/.bin/tsx \
    "$historical_fixture_container_path" websocket-hold \
    <"$state_path" >"$replacement" 2>"$lifecycle_path" &
  historical_websocket_holder_pid=$!

  wait_for_json_stage \
    "$lifecycle_path" "held" "$historical_websocket_holder_pid" \
    "historical WebSocket holder"
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$replacement" \
    || fail "held WebSocket fixture state was not valid JSON"
  chmod 600 "$replacement"
  mv "$replacement" "$state_path"
}

start_historical_connection_drain_observer() {
  local directory="$1"
  local evidence_path="$2"
  : >"$evidence_path"
  chmod 600 "$evidence_path"
  compose_for "$directory" exec -T collaboration node - <<'NODE' >"$evidence_path" 2>&1 &
(async () => {
  const format = "nyxdoc-release-historical-connection-drain/v1";
  const deadline = Date.now() + 300_000;
  let activeObserved = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:3101/health");
      if (!response.ok) throw new Error(`health ${response.status}`);
      const payload = await response.json();
      if (!Number.isSafeInteger(payload.connections) || payload.connections < 0) {
        throw new Error("invalid connection count");
      }
      if (!activeObserved && payload.connections > 0) {
        activeObserved = true;
        console.log(JSON.stringify({
          format,
          stage: "active",
          observedAt: new Date().toISOString(),
          connections: payload.connections,
        }));
      }
      if (activeObserved && payload.connections === 0) {
        console.log(JSON.stringify({
          format,
          stage: "drained",
          observedAt: new Date().toISOString(),
          connections: 0,
        }));
        return;
      }
    } catch {
      // The collaboration process stopping before a zero observation is not a
      // pass. Keep polling until Docker terminates this observer or it times out.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out observing an active-to-zero collaboration connection transition.");
})().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
NODE
  historical_drain_observer_pid=$!
  wait_for_json_stage \
    "$evidence_path" "active" "$historical_drain_observer_pid" \
    "historical connection drain observer"
}

wait_for_historical_websocket_drain() {
  local lifecycle_path="$1"
  local drain_path="$2"
  wait_for_json_stage \
    "$lifecycle_path" "disconnected" "$historical_websocket_holder_pid" \
    "historical WebSocket holder"
  wait_for_json_stage \
    "$drain_path" "drained" "$historical_drain_observer_pid" \
    "historical connection drain observer"
  if ! wait "$historical_websocket_holder_pid"; then
    fail "historical WebSocket holder failed after gateway shutdown"
  fi
  historical_websocket_holder_pid=""
  if ! wait "$historical_drain_observer_pid"; then
    fail "historical connection drain observer failed after gateway shutdown"
  fi
  historical_drain_observer_pid=""
}

enrich_historical_websocket_evidence() {
  local evidence_path="$1"
  local lifecycle_path="$2"
  local drain_path="$3"
  local connections_before="$4"
  local connections_after="$5"
  local replacement
  replacement="$(mktemp "${evidence_path}.tmp.XXXXXX")"
  node - \
    "$evidence_path" "$lifecycle_path" "$drain_path" \
    "$connections_before" "$connections_after" >"$replacement" <<'NODE'
const fs = require("node:fs");
const [evidencePath, lifecyclePath, drainPath, beforeRaw, afterRaw] = process.argv.slice(2);
const parseLines = (file) => fs.readFileSync(file, "utf8")
  .split(/\r?\n/u)
  .filter((line) => line.startsWith("{"))
  .map((line) => JSON.parse(line));
const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
const lifecycle = parseLines(lifecyclePath);
const drain = parseLines(drainPath);
const held = lifecycle.find((item) => item.stage === "held");
const disconnected = lifecycle.find((item) => item.stage === "disconnected");
const active = drain.find((item) => item.stage === "active");
const drained = drain.find((item) => item.stage === "drained");
if (!held || !disconnected || !active || !drained) {
  throw new Error("historical WebSocket lifecycle evidence is incomplete");
}
if (held.format !== "nyxdoc-release-historical-websocket-lifecycle/v1"
  || disconnected.format !== held.format
  || active.format !== "nyxdoc-release-historical-connection-drain/v1"
  || drained.format !== active.format) {
  throw new Error("historical WebSocket lifecycle evidence has an unexpected format");
}
if (held.documentId !== evidence.nestedDocumentId
  || disconnected.documentId !== held.documentId
  || held.workingContentSha256 !== evidence.workingContentSha256
  || disconnected.workingContentSha256 !== held.workingContentSha256
  || held.draftVersion !== evidence.draft?.draftVersion
  || disconnected.draftVersion !== held.draftVersion) {
  throw new Error("held WebSocket evidence does not match the accepted draft");
}
const connectionsBefore = Number(beforeRaw);
const connectionsAfter = Number(afterRaw);
if (!Number.isSafeInteger(connectionsBefore) || connectionsBefore < 1
  || !Number.isSafeInteger(active.connections) || active.connections < 1
  || drained.connections !== 0 || connectionsAfter !== 0) {
  throw new Error("historical WebSocket connection boundary was not active-to-zero");
}
for (const timestamp of [held.observedAt, disconnected.observedAt, active.observedAt, drained.observedAt]) {
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error("invalid lifecycle timestamp");
}
if (Date.parse(disconnected.observedAt) < Date.parse(held.observedAt)
  || Date.parse(drained.observedAt) < Date.parse(held.observedAt)) {
  throw new Error("historical WebSocket drained before it was held");
}
if (!Number.isSafeInteger(disconnected.closeCode)) {
  throw new Error("historical WebSocket disconnect close code is missing");
}
evidence.connectionDrain = {
  status: "passed",
  heldSocket: true,
  connectionsBeforeGatewayStop: connectionsBefore,
  observerActiveConnections: active.connections,
  observerDrainedConnections: drained.connections,
  connectionsAfterUpgrade: connectionsAfter,
  heldAt: held.observedAt,
  disconnectedAt: disconnected.observedAt,
  drainedAt: drained.observedAt,
  closeCode: disconnected.closeCode,
};
console.log(JSON.stringify(evidence));
NODE
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$replacement" \
    || fail "enriched historical WebSocket evidence was not valid JSON"
  chmod 600 "$replacement"
  mv "$replacement" "$evidence_path"
}

verify_historical_bridge_backup() {
  local directory="$1"
  local state_path="$2"
  local generation_path="$3"
  local evidence_path="$4"
  install_historical_fixture_driver "$directory"
  compose_for "$directory" exec -T --user node \
    app ./node_modules/.bin/tsx \
    "$historical_fixture_container_path" \
    verify-backup "$generation_path" <"$state_path" \
    | tee "$evidence_path" >>"$qualification_log"
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$evidence_path" \
    || fail "legacy bridge backup evidence was not valid JSON"
}

commit_historical_fixture() {
  local directory="$1"
  local state_path="$2"
  local replacement
  replacement="$(mktemp "${state_path}.tmp.XXXXXX")"
  install_historical_fixture_driver "$directory"
  compose_for "$directory" exec -T --user node \
    -e NYXDOC_TEST_BASE_URL=http://gateway:3002 \
    app ./node_modules/.bin/tsx \
    "$historical_fixture_container_path" commit \
    <"$state_path" >"$replacement"
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$replacement" \
    || fail "committed historical fixture state was not valid JSON"
  chmod 600 "$replacement"
  mv "$replacement" "$state_path"
}

extract_json_string() {
  local input="$1"
  local key="$2"
  printf '%s\n' "$input" \
    | sed -n "s/^[[:space:]]*\"${key}\":[[:space:]]*\"\([^\"]*\)\".*/\1/p" \
    | tail -n 1
}

extract_json_number() {
  local input="$1"
  local key="$2"
  printf '%s\n' "$input" \
    | sed -n "s/^[[:space:]]*\"${key}\":[[:space:]]*\([0-9][0-9]*\).*/\1/p" \
    | tail -n 1
}

cleanup_directory() {
  local directory="$1"
  [ -f "$directory/.env.production" ] || return 0
  compose_for "$directory" down --volumes --remove-orphans >/dev/null 2>&1 || true
}

cleanup() {
  if [ -n "$historical_websocket_holder_pid" ]; then
    kill "$historical_websocket_holder_pid" >/dev/null 2>&1 || true
    wait "$historical_websocket_holder_pid" >/dev/null 2>&1 || true
    historical_websocket_holder_pid=""
  fi
  if [ -n "$historical_drain_observer_pid" ]; then
    kill "$historical_drain_observer_pid" >/dev/null 2>&1 || true
    wait "$historical_drain_observer_pid" >/dev/null 2>&1 || true
    historical_drain_observer_pid=""
  fi
  cleanup_directory "$fresh_dir"
  cleanup_directory "$upgrade_dir"
  cleanup_directory "$restore_dir"
  for volume in "${fresh_volume:-}" "${upgrade_volume:-}" "${restore_volume:-}"; do
    [ -z "$volume" ] || docker volume rm -f "$volume" >/dev/null 2>&1 || true
  done
  git -C "$root" worktree remove --force "$fresh_dir" >/dev/null 2>&1 || true
  git -C "$root" worktree remove --force "$restore_dir" >/dev/null 2>&1 || true
  rm -rf "$temporary" >/dev/null 2>&1 || true
}
trap cleanup EXIT

git -C "$root" worktree add --detach "$fresh_dir" "$candidate_revision" >/dev/null
# The updater intentionally trusts canonical origin tags, not local tags. Build
# a disposable origin that includes the unpromoted candidate tag so pre-tag
# rehearsals exercise the same remote-tag path without publishing first. A
# separate repository also avoids worktrees sharing the caller's remote config.
# Populate it with a push instead of cloning the source repository: GitHub
# checkout and local rehearsals may use partial clones, and cloning a promisor
# repository can fail while trying to copy lazily fetched objects.
candidate_tag="$(git -C "$root" describe --tags --exact-match --match 'v[0-9]*' "$candidate_revision" 2>/dev/null || true)"
[[ "$candidate_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail "candidate revision must have an exact stable semver tag for update rehearsal"
git init --bare --initial-branch=main "$update_origin" >/dev/null
git -C "$root" push "$update_origin" \
  "$candidate_revision:refs/heads/main" \
  "$baseline_ref:refs/tags/$baseline_ref" \
  "refs/tags/$candidate_tag:refs/tags/$candidate_tag" >/dev/null
git clone --no-local --no-checkout "$update_origin" "$upgrade_dir" >/dev/null
git -C "$upgrade_dir" checkout --detach "$baseline_ref" >/dev/null

fresh_volume="nyxdoc_release_${run_id}_fresh"
fresh_backup="$artifact_dir/fresh-backups"
prepare_environment "$fresh_dir" "$candidate_image" "$fresh_port" "$fresh_volume" "$fresh_backup"
(cd "$fresh_dir" && ./scripts/install.sh)
verify_service_image "$fresh_dir" "$candidate_image"
wait_for_services "$fresh_dir" "$fresh_port"
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
wait_for_services "$fresh_dir" "$fresh_port"
checks["fresh-reinstall"]="passed"
cleanup_directory "$fresh_dir"

upgrade_volume="nyxdoc_release_${run_id}_upgrade"
upgrade_backup="$artifact_dir/upgrade-backups"
prepare_environment "$upgrade_dir" "$baseline_image" "$upgrade_port" "$upgrade_volume" "$upgrade_backup"
(cd "$upgrade_dir" && ./scripts/install.sh)
wait_for_services "$upgrade_dir" "$upgrade_port"
historical_email="release-upgrade-${run_id}@example.test"
create_authenticated_workspace "$upgrade_dir" "$upgrade_port" "$historical_email"
checks["historical-auth-session"]="passed"
create_historical_fixture "$upgrade_dir" "$historical_email" "$historical_fixture_state"
verify_historical_fixture \
  "$upgrade_dir" "$historical_fixture_state" "baseline-dirty" \
  "$artifact_dir/baseline-fixture-evidence.json"
baseline_fixture_evidence="$(<"$artifact_dir/baseline-fixture-evidence.json")"
checks["historical-fixture-created"]="passed"
baseline_schema="$(database_integrity "$upgrade_dir")"
checks["historical-install"]="passed"

historical_websocket_lifecycle="$artifact_dir/historical-websocket-lifecycle.ndjson"
historical_connection_drain="$artifact_dir/historical-connection-drain.ndjson"
start_historical_fixture_websocket_hold \
  "$upgrade_dir" "$historical_fixture_state" "$historical_websocket_lifecycle"
verify_historical_fixture \
  "$upgrade_dir" "$historical_fixture_state" "baseline-websocket-dirty" \
  "$artifact_dir/baseline-websocket-fixture-evidence.json"
historical_connections_before="$(historical_collaboration_connections "$upgrade_dir" || true)"
[[ "$historical_connections_before" =~ ^[1-9][0-9]*$ ]] \
  || fail "held historical WebSocket was not visible as an active collaboration connection"
start_historical_connection_drain_observer \
  "$upgrade_dir" "$historical_connection_drain"

bridge_output="$(
  NYXDOC_UPDATE_ROOT="$upgrade_dir" \
    NYXDOC_UPDATE_IMAGE="$candidate_image" \
    NYXDOC_OFFICIAL_RELEASE_SOURCE="$update_origin" \
    bash "$root/scripts/update-bootstrap.sh" 2>&1
)"
printf '%s\n' "$bridge_output" >>"$qualification_log"
bridge_backup_generation_path="$(printf '%s\n' "$bridge_output" \
  | sed -n 's/^\[nyxdoc\] Legacy bridge verified backup: \(\/backups\/[A-Za-z0-9._-]*\)$/\1/p' \
  | tail -n 1)"
[[ "$bridge_backup_generation_path" =~ ^/backups/[A-Za-z0-9._-]+$ ]] \
  || fail "historical update bridge did not report its verified backup generation"
checks["historical-update-bootstrap"]="passed"
wait_for_historical_websocket_drain \
  "$historical_websocket_lifecycle" "$historical_connection_drain"
updated_revision="$(git -C "$upgrade_dir" rev-parse HEAD)"
[ "$updated_revision" = "$candidate_revision" ] \
  || fail "historical update checked out ${updated_revision}, not the release candidate revision"
verify_service_image "$upgrade_dir" "$candidate_image"
wait_for_services "$upgrade_dir" "$upgrade_port"
checks["historical-upgrade"]="passed"
checks["historical-http-health"]="passed"
historical_connections_after="$(historical_collaboration_connections "$upgrade_dir" || true)"
[ "$historical_connections_after" = "0" ] \
  || fail "historical WebSocket holder reconnected after the first-hop upgrade"
enrich_historical_websocket_evidence \
  "$artifact_dir/baseline-websocket-fixture-evidence.json" \
  "$historical_websocket_lifecycle" "$historical_connection_drain" \
  "$historical_connections_before" "$historical_connections_after"
baseline_websocket_evidence="$(<"$artifact_dir/baseline-websocket-fixture-evidence.json")"
checks["historical-websocket-mutation"]="passed"
verify_historical_bridge_backup \
  "$upgrade_dir" "$historical_fixture_state" "$bridge_backup_generation_path" \
  "$artifact_dir/legacy-bridge-backup-evidence.json"
legacy_bridge_backup_evidence="$(<"$artifact_dir/legacy-bridge-backup-evidence.json")"
checks["historical-legacy-bridge-backup"]="passed"
candidate_schema="$(database_integrity "$upgrade_dir")"
checks["historical-database-integrity"]="passed"
assert_historical_data_preserved "$baseline_schema" "$candidate_schema"
checks["historical-data-preserved"]="passed"
verify_historical_fixture \
  "$upgrade_dir" "$historical_fixture_state" "candidate-upgrade-dirty" \
  "$artifact_dir/candidate-dirty-fixture-evidence.json"
candidate_dirty_evidence="$(<"$artifact_dir/candidate-dirty-fixture-evidence.json")"
checks["historical-fixture-upgrade-preserved"]="passed"

(cd "$upgrade_dir" && ./scripts/uninstall.sh)
docker volume inspect "$upgrade_volume" >/dev/null \
  || fail "normal uninstall did not preserve the historical fixture volume"
(cd "$upgrade_dir" && ./scripts/install.sh)
verify_service_image "$upgrade_dir" "$candidate_image"
wait_for_services "$upgrade_dir" "$upgrade_port"
verify_historical_fixture \
  "$upgrade_dir" "$historical_fixture_state" "candidate-normal-reinstall" \
  "$artifact_dir/reinstall-fixture-evidence.json"
reinstall_fixture_evidence="$(<"$artifact_dir/reinstall-fixture-evidence.json")"
checks["historical-fixture-reinstall-preserved"]="passed"

backup_output="$(
  compose_for "$upgrade_dir" exec -T --user node app npm run backup:create
)"
printf '%s\n' "$backup_output" >>"$qualification_log"
backup_generation_id="$(extract_json_string "$backup_output" generationId)"
backup_generation_path="$(extract_json_string "$backup_output" generationPath)"
backup_media_files="$(extract_json_number "$backup_output" mediaFiles)"
backup_media_bytes="$(extract_json_number "$backup_output" mediaBytes)"
[[ "$backup_generation_id" =~ ^[A-Za-z0-9._-]+$ ]] \
  || fail "verified backup did not return a valid generation ID"
[ "$backup_generation_path" = "/backups/$backup_generation_id" ] \
  || fail "verified backup generation path did not match its ID"
backup_verification_output="$(
  compose_for "$upgrade_dir" exec -T --user node \
    app npm run backup:verify -- "$backup_generation_path"
)"
printf '%s\n' "$backup_verification_output" >>"$qualification_log"
backup_database_sha256="$(extract_json_string "$backup_verification_output" databaseSha256)"
backup_media_tree_sha256="$(extract_json_string "$backup_verification_output" mediaTreeSha256)"
[[ "$backup_database_sha256" =~ ^[a-f0-9]{64}$ ]] \
  || fail "verified backup database digest was missing"
[[ "$backup_media_tree_sha256" =~ ^[a-f0-9]{64}$ ]] \
  || fail "verified backup media digest was missing"
[[ "$backup_media_files" =~ ^[1-9][0-9]*$ ]] \
  || fail "verified backup did not contain uploaded media"
[[ "$backup_media_bytes" =~ ^[1-9][0-9]*$ ]] \
  || fail "verified backup media byte count was empty"
checks["historical-backup-verified"]="passed"

git -C "$root" worktree add --detach "$restore_dir" "$candidate_revision" >/dev/null
restore_volume="nyxdoc_release_${run_id}_restore"
restore_backup="$upgrade_backup"
prepare_environment \
  "$restore_dir" "$candidate_image" "$restore_port" \
  "$restore_volume" "$restore_backup"
if docker volume inspect "$restore_volume" >/dev/null 2>&1; then
  fail "isolated restore volume already existed before rehearsal"
fi
docker volume create "$restore_volume" >/dev/null
docker run --rm --entrypoint /bin/sh \
  --mount "type=volume,src=${restore_volume},dst=/restore" \
  "$candidate_image" -c \
  'test -z "$(find /restore -mindepth 1 -maxdepth 1 -print -quit)" && chown node:node /restore' \
  || fail "isolated restore volume was not empty"
checks["historical-restore-empty-volume"]="passed"
restore_output="$(
  compose_for "$restore_dir" run --rm --no-deps --user node app \
    npm run backup:restore -- "$backup_generation_path" \
    --database /data/nyxdoc.db \
    --media /data/media \
    --confirm-generation "$backup_generation_id"
)"
printf '%s\n' "$restore_output" >>"$qualification_log"
restore_status="$(extract_json_string "$restore_output" status)"
[ "$restore_status" = "restored-and-verified" ] \
  || fail "isolated backup restore did not report restored-and-verified"
(cd "$restore_dir" && ./scripts/install.sh)
verify_service_image "$restore_dir" "$candidate_image"
wait_for_services "$restore_dir" "$restore_port"
verify_historical_fixture \
  "$restore_dir" "$historical_fixture_state" "candidate-isolated-restore" \
  "$artifact_dir/restore-fixture-evidence.json"
restore_fixture_evidence="$(<"$artifact_dir/restore-fixture-evidence.json")"
checks["historical-restore-objects-preserved"]="passed"
cleanup_directory "$restore_dir"

commit_historical_fixture "$upgrade_dir" "$historical_fixture_state"
verify_historical_fixture \
  "$upgrade_dir" "$historical_fixture_state" "candidate-commit-reload" \
  "$artifact_dir/candidate-committed-fixture-evidence.json"
candidate_committed_evidence="$(<"$artifact_dir/candidate-committed-fixture-evidence.json")"
checks["historical-fixture-commit-reload"]="passed"

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
  "historical-update-bootstrap"
  "historical-upgrade"
  "historical-auth-session"
  "historical-http-health"
  "historical-browser-session"
  "historical-collaboration-websocket"
  "historical-mcp-http"
  "historical-database-integrity"
  "historical-data-preserved"
  "historical-fixture-created"
  "historical-websocket-mutation"
  "historical-legacy-bridge-backup"
  "historical-fixture-upgrade-preserved"
  "historical-fixture-commit-reload"
  "historical-fixture-reinstall-preserved"
  "historical-backup-verified"
  "historical-restore-empty-volume"
  "historical-restore-objects-preserved"
)
for required_check in "${required_checks[@]}"; do
  [ "${checks[$required_check]:-}" = "passed" ] \
    || fail "required matrix evidence is absent for ${required_check}"
done
mkdir -p "$(dirname -- "$receipt_path")"
node - \
  "$receipt_path" "$candidate_image" "$candidate_digest" "$candidate_revision" \
  "$baseline_ref" "$baseline_image" "$baseline_immutable_image" "$baseline_digest" "$baseline_revision" \
  "$baseline_schema" "$candidate_schema" \
  "$baseline_fixture_evidence" "$candidate_dirty_evidence" \
  "$baseline_websocket_evidence" "$legacy_bridge_backup_evidence" \
  "$candidate_committed_evidence" "$reinstall_fixture_evidence" \
  "$restore_fixture_evidence" "$backup_generation_id" "$backup_generation_path" \
  "$backup_database_sha256" "$backup_media_tree_sha256" "$backup_media_files" \
  "$backup_media_bytes" "$restore_status" <<'NODE'
const [
  receiptPath,
  image,
  digest,
  revision,
  baselineRef,
  baselineImage,
  baselineImmutableImage,
  baselineDigest,
  baselineRevision,
  baselineSchema,
  candidateSchema,
  baselineFixtureEvidence,
  candidateDirtyEvidence,
  baselineWebsocketEvidence,
  legacyBridgeBackupEvidence,
  candidateCommittedEvidence,
  reinstallFixtureEvidence,
  restoreFixtureEvidence,
  backupGenerationId,
  backupGenerationPath,
  backupDatabaseSha256,
  backupMediaTreeSha256,
  backupMediaFiles,
  backupMediaBytes,
  restoreStatus,
] = process.argv.slice(2);
const checkIds = [
  "candidate-provenance",
  "fresh-install",
  "fresh-auth-session",
  "fresh-http-health",
  "fresh-browser-session",
  "fresh-collaboration-websocket",
  "fresh-mcp-http",
  "fresh-reinstall",
  "historical-install",
  "historical-update-bootstrap",
  "historical-upgrade",
  "historical-auth-session",
  "historical-http-health",
  "historical-browser-session",
  "historical-collaboration-websocket",
  "historical-mcp-http",
  "historical-database-integrity",
  "historical-data-preserved",
  "historical-fixture-created",
  "historical-websocket-mutation",
  "historical-legacy-bridge-backup",
  "historical-fixture-upgrade-preserved",
  "historical-fixture-commit-reload",
  "historical-fixture-reinstall-preserved",
  "historical-backup-verified",
  "historical-restore-empty-volume",
  "historical-restore-objects-preserved",
];
const checks = Object.fromEntries(checkIds.map((id) => [id, { status: "passed" }]));
require("node:fs").writeFileSync(receiptPath, `${JSON.stringify({
  format: "nyxdoc-release-qualification/v1",
  generatedAt: new Date().toISOString(),
  candidate: { image, digest, revision },
  baseline: {
    ref: baselineRef,
    image: baselineImage,
    immutableImage: baselineImmutableImage,
    digest: baselineDigest,
    revision: baselineRevision,
  },
  checks,
  database: {
    baseline: JSON.parse(baselineSchema),
    candidate: JSON.parse(candidateSchema),
  },
  historicalFixture: {
    baselineDirty: JSON.parse(baselineFixtureEvidence),
    websocketBeforeFirstHop: JSON.parse(baselineWebsocketEvidence),
    legacyBridgeBackup: JSON.parse(legacyBridgeBackupEvidence),
    candidateDirty: JSON.parse(candidateDirtyEvidence),
    normalReinstall: JSON.parse(reinstallFixtureEvidence),
    isolatedRestore: JSON.parse(restoreFixtureEvidence),
    candidateCommitted: JSON.parse(candidateCommittedEvidence),
  },
  backupRestore: {
    generationId: backupGenerationId,
    generationPath: backupGenerationPath,
    databaseSha256: backupDatabaseSha256,
    mediaTreeSha256: backupMediaTreeSha256,
    mediaFiles: Number(backupMediaFiles),
    mediaBytes: Number(backupMediaBytes),
    restoreStatus,
    targetVolumeWasEmpty: true,
  },
}, null, 2)}\n`);
NODE

node "$root/scripts/verify-release-qualification-receipt.mjs" \
  --receipt "$receipt_path" \
  --candidate-image "$candidate_image" \
  --candidate-revision "$candidate_revision"
printf '[nyxdoc] release qualification passed for %s\n' "$candidate_image"
