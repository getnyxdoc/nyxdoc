import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  WebSocketStatus,
  type onDisconnectParameters,
} from "@hocuspocus/provider";
import Database from "better-sqlite3";
import WebSocket from "ws";
import * as Y from "yjs";

type DocumentContent = {
  schemaVersion: number;
  blocks: Array<Record<string, unknown>>;
};

type DocumentDetail = {
  id: string;
  workspaceId: string;
  title: string;
  parentDocumentId: string | null;
  revisionId: string | null;
  revisionNumber: number;
  documentType: string | null;
  workflowStatus: "draft" | "review" | "final";
  tags: string[];
  content: DocumentContent;
};

type WorkingDocument = {
  documentId: string;
  workspaceId: string;
  generation: number;
  roomName: string;
  baseRevisionId: string | null;
  baseRevisionNumber: number;
  draftVersion: number;
  committedDraftVersion: number;
  hasUncommittedChanges: boolean;
  title: string;
  parentDocumentId: string | null;
  metadata: {
    documentType: string | null;
    workflowStatus: "draft" | "review" | "final";
    tags: string[];
  };
  content: DocumentContent;
};

type RevisionSnapshot = {
  id: string;
  number: number;
  title: string;
  parentDocumentId: string | null;
  metadata: WorkingDocument["metadata"];
  content: DocumentContent;
};

type FixtureState = {
  format: "nyxdoc-release-historical-fixture/v1";
  credential: { token: string };
  workspaceId: string;
  parent: DocumentDetail;
  nested: {
    canonical: DocumentDetail;
    working: WorkingDocument;
    revisions: RevisionSnapshot[];
  };
  media: {
    id: string;
    url: string;
    mimeType: string;
    byteSize: number;
    sha256: string;
  };
};

const baseUrl = process.env.NYXDOC_TEST_BASE_URL?.replace(/\/$/, "");
if (!baseUrl) throw new Error("NYXDOC_TEST_BASE_URL is required");

const mediaBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const mediaSha256 = createHash("sha256").update(mediaBytes).digest("hex");

function jsonSha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function blockIds(content: DocumentContent) {
  return content.blocks.map((block) => {
    assert.equal(typeof block.id, "string", "fixture top-level block ID is missing");
    return block.id;
  });
}

function canonicalDocument(document: DocumentDetail): DocumentDetail {
  return {
    id: document.id,
    workspaceId: document.workspaceId,
    title: document.title,
    parentDocumentId: document.parentDocumentId,
    revisionId: document.revisionId,
    revisionNumber: document.revisionNumber,
    documentType: document.documentType,
    workflowStatus: document.workflowStatus,
    tags: document.tags,
    content: document.content,
  };
}

function workingDocument(document: WorkingDocument): WorkingDocument {
  return {
    documentId: document.documentId,
    workspaceId: document.workspaceId,
    generation: document.generation,
    roomName: document.roomName,
    baseRevisionId: document.baseRevisionId,
    baseRevisionNumber: document.baseRevisionNumber,
    draftVersion: document.draftVersion,
    committedDraftVersion: document.committedDraftVersion,
    hasUncommittedChanges: document.hasUncommittedChanges,
    title: document.title,
    parentDocumentId: document.parentDocumentId,
    metadata: document.metadata,
    content: document.content,
  };
}

function revisionSnapshot(revision: RevisionSnapshot): RevisionSnapshot {
  return {
    id: revision.id,
    number: revision.number,
    title: revision.title,
    parentDocumentId: revision.parentDocumentId,
    metadata: revision.metadata,
    content: revision.content,
  };
}

async function requestJson<T>(
  token: string,
  pathname: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${pathname} failed (${response.status}): ${text}`);
  }
  return JSON.parse(text) as T;
}

async function readState(): Promise<FixtureState> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const state = JSON.parse(Buffer.concat(chunks).toString("utf8")) as FixtureState;
  assert.equal(state.format, "nyxdoc-release-historical-fixture/v1");
  assert.match(state.credential.token, /^nyx_live_/);
  return state;
}

async function getDocument(token: string, documentId: string) {
  const payload = await requestJson<{ document: DocumentDetail }>(
    token,
    `/api/v1/documents/${documentId}`,
  );
  return canonicalDocument(payload.document);
}

async function getWorkingDocument(token: string, documentId: string) {
  const payload = await requestJson<{ workingDocument: WorkingDocument }>(
    token,
    `/api/v1/documents/${documentId}/working`,
  );
  return workingDocument(payload.workingDocument);
}

async function getRevisionSnapshots(token: string, documentId: string) {
  const listed = await requestJson<{
    revisions: Array<{ id: string; number: number }>;
  }>(token, `/api/v1/documents/${documentId}/revisions?limit=50`);
  const revisions = [...listed.revisions].sort((left, right) => left.number - right.number);
  return Promise.all(revisions.map(async ({ id, number }) => {
    const payload = await requestJson<{ revision: RevisionSnapshot }>(
      token,
      `/api/v1/documents/${documentId}/revisions/${number}`,
    );
    assert.equal(payload.revision.id, id, `revision ${number} ID changed between list and read`);
    return revisionSnapshot(payload.revision);
  }));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function assertMedia(token: string, state: FixtureState) {
  const response = await fetch(`${baseUrl}${state.media.url}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`GET ${state.media.url} failed (${response.status}): ${await response.text()}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.headers.get("content-type"), state.media.mimeType);
  assert.equal(bytes.byteLength, state.media.byteSize);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), state.media.sha256);
  assert.deepEqual(bytes, mediaBytes, "uploaded media bytes changed");
}

function verificationEvidence(state: FixtureState, stage: string) {
  return {
    format: "nyxdoc-release-historical-evidence/v1",
    stage,
    workspaceId: state.workspaceId,
    parentDocumentId: state.parent.id,
    nestedDocumentId: state.nested.canonical.id,
    nestedDocumentTitle: state.nested.canonical.title,
    parentDocumentIdFromNested: state.nested.canonical.parentDocumentId,
    canonicalRevisionIds: state.nested.revisions.map((revision) => revision.id),
    canonicalRevisionContentSha256: state.nested.revisions.map((revision) => jsonSha256(revision.content)),
    canonicalRevisionCount: state.nested.revisions.length,
    canonicalRevisionNumber: state.nested.canonical.revisionNumber,
    parentContentSha256: jsonSha256(state.parent.content),
    canonicalContentSha256: jsonSha256(state.nested.canonical.content),
    workingContentSha256: jsonSha256(state.nested.working.content),
    canonicalBlockIds: blockIds(state.nested.canonical.content),
    workingBlockIds: blockIds(state.nested.working.content),
    draft: {
      generation: state.nested.working.generation,
      draftVersion: state.nested.working.draftVersion,
      committedDraftVersion: state.nested.working.committedDraftVersion,
      baseRevisionId: state.nested.working.baseRevisionId,
      baseRevisionNumber: state.nested.working.baseRevisionNumber,
      hasUncommittedChanges: state.nested.working.hasUncommittedChanges,
    },
    media: {
      id: state.media.id,
      mimeType: state.media.mimeType,
      byteSize: state.media.byteSize,
      sha256: state.media.sha256,
    },
  };
}

async function verify(state: FixtureState, stage: string) {
  const token = state.credential.token;
  assert.deepEqual(await getDocument(token, state.parent.id), state.parent, "parent document changed");
  assert.deepEqual(
    await getDocument(token, state.nested.canonical.id),
    state.nested.canonical,
    "nested canonical document changed",
  );
  assert.deepEqual(
    await getRevisionSnapshots(token, state.nested.canonical.id),
    state.nested.revisions,
    "canonical revision IDs or snapshots changed",
  );
  assert.deepEqual(
    await getWorkingDocument(token, state.nested.canonical.id),
    state.nested.working,
    "working draft state or content changed",
  );
  await assertMedia(token, state);
  assert.equal(state.nested.canonical.parentDocumentId, state.parent.id);
  assert(state.nested.revisions.length >= 2, "historical fixture requires at least two revisions");
  console.log(JSON.stringify(verificationEvidence(state, stage)));
}

type WebSocketDisconnect = {
  code: number;
};

function writeWebSocketLifecycleEvent(input: {
  stage: "held" | "disconnected";
  state: FixtureState;
  disconnect?: WebSocketDisconnect;
}) {
  const payload = {
    format: "nyxdoc-release-historical-websocket-lifecycle/v1",
    stage: input.stage,
    observedAt: new Date().toISOString(),
    documentId: input.state.nested.canonical.id,
    workingContentSha256: jsonSha256(input.state.nested.working.content),
    draftVersion: input.state.nested.working.draftVersion,
    ...(input.disconnect ? {
      closeCode: input.disconnect.code,
    } : {}),
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

async function mutateThroughWebSocket(
  state: FixtureState,
  options: { holdUntilDisconnect?: boolean } = {},
) {
  const [
    { createCollaborationToken },
    { replaceWorkingDocument },
    { nyxdocDocumentV2Schema },
  ] = await Promise.all([
    import("../../src/lib/collaboration/token"),
    import("../../src/lib/collaboration/drafts"),
    import("../../src/lib/editor/schema"),
  ]);
  const expectedContent = nyxdocDocumentV2Schema.parse({
    ...state.nested.working.content,
    blocks: [
      ...state.nested.working.content.blocks,
      {
        id: "rq-historical-websocket-first-hop",
        type: "p",
        children: [{ text: "WebSocket mutation accepted immediately before the legacy first hop." }],
      },
    ],
  });
  const token = createCollaborationToken({
    roomName: state.nested.working.roomName,
    workspaceId: state.workspaceId,
    documentId: state.nested.canonical.id,
    generation: state.nested.working.generation,
    actor: {
      type: "agent",
      principalId: "release-qualification-websocket",
      label: "Release qualification WebSocket",
      source: "api",
    },
    permissions: { read: true, write: true, commit: false },
  });
  const document = new Y.Doc();
  const authenticationFailures: string[] = [];
  let resolveDisconnect!: (value: WebSocketDisconnect) => void;
  const disconnected = new Promise<WebSocketDisconnect>((resolve) => {
    resolveDisconnect = resolve;
  });
  let disconnectObserved: WebSocketDisconnect | null = null;
  const websocketProvider = new HocuspocusProviderWebsocket({
    url: `${baseUrl!.replace(/^http/u, "ws")}/collaboration`,
    WebSocketPolyfill: WebSocket,
    delay: 25,
    minDelay: 25,
    initialDelay: 0,
    maxAttempts: 1,
    jitter: false,
  });
  websocketProvider.on("disconnect", ({ event }: onDisconnectParameters) => {
    disconnectObserved = { code: event.code };
    // The hold-mode client is evidence for one specific pre-update socket. It
    // must never reconnect to the candidate service after the gateway closes,
    // otherwise the test would no longer prove a drained boundary.
    if (options.holdUntilDisconnect) websocketProvider.shouldConnect = false;
    resolveDisconnect(disconnectObserved);
  });
  const provider = new HocuspocusProvider({
    websocketProvider,
    name: state.nested.working.roomName,
    document,
    token,
    onAuthenticationFailed: ({ reason }) => authenticationFailures.push(reason),
  });
  try {
    provider.attach();
    await waitFor(
      () => provider.synced || authenticationFailures.length > 0,
      "historical provider synchronization",
    );
    assert.equal(
      authenticationFailures.length,
      0,
      `historical WebSocket authentication failed: ${authenticationFailures.join(", ")}`,
    );
    assert.equal(provider.synced, true, "historical WebSocket provider did not synchronize");
    replaceWorkingDocument(document, { content: expectedContent }, "release-qualification-websocket");
    await waitFor(async () => {
      const current = await getWorkingDocument(
        state.credential.token,
        state.nested.canonical.id,
      );
      return current.content.blocks.some(
        (block) => block.id === "rq-historical-websocket-first-hop",
      );
    }, "accepted WebSocket mutation persistence");
    const working = await getWorkingDocument(
      state.credential.token,
      state.nested.canonical.id,
    );
    assert.deepEqual(working.content, expectedContent);
    assert.equal(working.hasUncommittedChanges, true);
    const nextState = {
      ...state,
      nested: { ...state.nested, working },
    } satisfies FixtureState;

    if (!options.holdUntilDisconnect) {
      console.log(JSON.stringify(nextState));
      return;
    }

    assert.equal(
      websocketProvider.status,
      WebSocketStatus.Connected,
      "historical WebSocket disconnected before the first-hop hold boundary",
    );
    assert.equal(
      disconnectObserved,
      null,
      "historical WebSocket disconnect was observed before the hold boundary",
    );
    // State contains the test credential and therefore goes only to the
    // caller's private state file on stdout. Lifecycle evidence on stderr is
    // deliberately credential-free and safe to retain as an artifact.
    process.stdout.write(`${JSON.stringify(nextState)}\n`);
    writeWebSocketLifecycleEvent({ stage: "held", state: nextState });

    const holdTimeoutMs = Number(process.env.NYXDOC_TEST_WS_HOLD_TIMEOUT_MS ?? 600_000);
    assert(
      Number.isSafeInteger(holdTimeoutMs) && holdTimeoutMs > 0,
      "NYXDOC_TEST_WS_HOLD_TIMEOUT_MS must be a positive integer",
    );
    let timeout: NodeJS.Timeout | undefined;
    const disconnect = await Promise.race([
      disconnected,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out waiting for the legacy gateway to close the held WebSocket")),
          holdTimeoutMs,
        );
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    writeWebSocketLifecycleEvent({
      stage: "disconnected",
      state: nextState,
      disconnect,
    });
  } finally {
    provider.destroy();
    websocketProvider.destroy();
    document.destroy();
  }
}

async function verifyBackupWorkingDocument(state: FixtureState, generationPath: string) {
  assert.match(generationPath, /^\/backups\/[A-Za-z0-9._-]+$/u);
  const [{ loadCollaborationStateByRoom, collaborationYDocFromState, workingDocumentFromYDoc }] =
    await Promise.all([import("../../src/lib/collaboration/drafts")]);
  const database = new Database(path.join(generationPath, "nyxdoc.db"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const stored = loadCollaborationStateByRoom(database, state.nested.working.roomName);
    const document = collaborationYDocFromState(stored.state);
    try {
      assert.deepEqual(
        workingDocumentFromYDoc(database, state.nested.working.roomName, document),
        state.nested.working,
        "legacy bridge backup did not contain the last accepted WebSocket draft",
      );
    } finally {
      document.destroy();
    }
  } finally {
    database.close();
  }
  console.log(JSON.stringify({
    format: "nyxdoc-release-historical-backup-evidence/v1",
    generationPath,
    documentId: state.nested.canonical.id,
    workingContentSha256: jsonSha256(state.nested.working.content),
    draftVersion: state.nested.working.draftVersion,
    status: "passed",
  }));
}

async function create(email: string) {
  const [{ sqlite }, { createWorkspaceToken }] = await Promise.all([
    import("../../src/lib/db/client"),
    import("../../src/lib/tokens/service"),
  ]);
  const membership = sqlite.prepare(
    `SELECT wm.workspace_id, wm.user_id
     FROM workspace_members wm
     JOIN user u ON u.id = wm.user_id
     WHERE u.email = ?
     ORDER BY wm.created_at ASC LIMIT 1`,
  ).get(email) as { workspace_id: string; user_id: string } | undefined;
  assert(membership, `workspace membership not found for ${email}`);
  const createdToken = createWorkspaceToken(sqlite, {
    workspaceId: membership.workspace_id,
    userId: membership.user_id,
    name: "Release qualification historical fixture",
    role: "admin",
  });
  const token = createdToken.token;

  const parentContent: DocumentContent = {
    schemaVersion: 2,
    blocks: [
      { id: "rq-historical-parent-heading", type: "h1", children: [{ text: "Historical fixture parent" }] },
      { id: "rq-historical-parent-body", type: "p", children: [{ text: "Stable parent content." }] },
    ],
  };
  const parentPayload = await requestJson<{ document: DocumentDetail }>(token, "/api/v1/documents", {
    method: "POST",
    body: JSON.stringify({
      requestId: "rq-historical-create-parent-v1",
      title: "Release Qualification Historical Parent",
      documentType: "release-qualification",
      workflowStatus: "review",
      tags: ["historical", "release-qualification"],
      content: parentContent,
      summary: "Create the historical fixture parent.",
    }),
  });
  const parent = canonicalDocument(parentPayload.document);

  const initialContent: DocumentContent = {
    schemaVersion: 2,
    blocks: [
      { id: "rq-historical-child-heading", type: "h1", children: [{ text: "Canonical revision one" }] },
      { id: "rq-historical-child-body", type: "p", children: [{ text: "Stable nested document body." }] },
    ],
  };
  const childPayload = await requestJson<{ document: DocumentDetail }>(token, "/api/v1/documents", {
    method: "POST",
    body: JSON.stringify({
      requestId: "rq-historical-create-child-v1",
      title: "Release Qualification Historical Nested Document",
      parentDocumentId: parent.id,
      documentType: "release-qualification",
      workflowStatus: "review",
      tags: ["historical", "nested"],
      content: initialContent,
      summary: "Create canonical revision one for the nested fixture.",
    }),
  });
  const childId = childPayload.document.id;

  const form = new FormData();
  form.append("file", new Blob([mediaBytes], { type: "image/png" }), "release-qualification.png");
  const uploaded = await requestJson<{
    media: { id: string; url: string; mimeType: string; byteSize: number };
  }>(token, `/api/media?document=${childId}`, { method: "POST", body: form });
  assert.equal(uploaded.media.mimeType, "image/png");
  assert.equal(uploaded.media.byteSize, mediaBytes.byteLength);

  const canonicalContent: DocumentContent = {
    schemaVersion: 2,
    blocks: [
      { id: "rq-historical-child-heading", type: "h1", children: [{ text: "Canonical revision two" }] },
      { id: "rq-historical-child-body", type: "p", children: [{ text: "Stable nested document body." }] },
      {
        id: "rq-historical-child-media",
        type: "img",
        mediaId: uploaded.media.id,
        url: uploaded.media.url,
        alt: "Release qualification pixel",
        name: "release-qualification.png",
        children: [{ text: "" }],
      },
      { id: "rq-historical-canonical-marker", type: "p", children: [{ text: "Canonical media revision marker." }] },
    ],
  };
  const canonicalDraft = await requestJson<{ workingDocument: WorkingDocument }>(
    token,
    `/api/v1/documents/${childId}`,
    {
      method: "PUT",
      body: JSON.stringify({
        requestId: "rq-historical-canonical-draft-v1",
        expectedDraftVersion: 0,
        content: canonicalContent,
      }),
    },
  );
  assert.equal(canonicalDraft.workingDocument.hasUncommittedChanges, true);
  const committed = await requestJson<{ document: DocumentDetail; workingDocument: WorkingDocument }>(
    token,
    `/api/v1/documents/${childId}/commit`,
    {
      method: "POST",
      body: JSON.stringify({
        requestId: "rq-historical-canonical-commit-v1",
        expectedDraftVersion: canonicalDraft.workingDocument.draftVersion,
        summary: "Create canonical revision two with uploaded media.",
      }),
    },
  );
  assert.equal(committed.document.revisionNumber, 2);
  assert.equal(committed.workingDocument.hasUncommittedChanges, false);

  const dirtyContent: DocumentContent = {
    ...canonicalContent,
    blocks: [
      ...canonicalContent.blocks,
      { id: "rq-historical-working-draft", type: "p", children: [{ text: "Uncommitted working draft survives." }] },
    ],
  };
  const dirty = await requestJson<{ workingDocument: WorkingDocument }>(
    token,
    `/api/v1/documents/${childId}`,
    {
      method: "PUT",
      body: JSON.stringify({
        requestId: "rq-historical-uncommitted-draft-v1",
        expectedDraftVersion: committed.workingDocument.draftVersion,
        content: dirtyContent,
      }),
    },
  );
  assert.equal(dirty.workingDocument.hasUncommittedChanges, true);

  const state: FixtureState = {
    format: "nyxdoc-release-historical-fixture/v1",
    credential: { token },
    workspaceId: membership.workspace_id,
    parent,
    nested: {
      canonical: canonicalDocument(committed.document),
      working: workingDocument(dirty.workingDocument),
      revisions: await getRevisionSnapshots(token, childId),
    },
    media: {
      id: uploaded.media.id,
      url: uploaded.media.url,
      mimeType: uploaded.media.mimeType,
      byteSize: uploaded.media.byteSize,
      sha256: mediaSha256,
    },
  };
  assert.equal(state.nested.revisions.length, 2);
  console.log(JSON.stringify(state));
}

async function commit(state: FixtureState) {
  assert.equal(state.nested.working.hasUncommittedChanges, true, "expected a dirty historical draft");
  const committed = await requestJson<{ document: DocumentDetail; workingDocument: WorkingDocument }>(
    state.credential.token,
    `/api/v1/documents/${state.nested.canonical.id}/commit`,
    {
      method: "POST",
      body: JSON.stringify({
        requestId: "rq-candidate-upgrade-commit-v1",
        expectedDraftVersion: state.nested.working.draftVersion,
        summary: "Commit the upgraded historical working draft.",
      }),
    },
  );
  assert.equal(committed.document.id, state.nested.canonical.id);
  assert.equal(committed.document.revisionNumber, state.nested.canonical.revisionNumber + 1);
  assert.equal(committed.workingDocument.hasUncommittedChanges, false);
  assert.deepEqual(committed.document.content, state.nested.working.content);
  const nextState: FixtureState = {
    ...state,
    nested: {
      canonical: canonicalDocument(committed.document),
      working: workingDocument(committed.workingDocument),
      revisions: await getRevisionSnapshots(state.credential.token, state.nested.canonical.id),
    },
  };
  assert.equal(nextState.nested.revisions.length, state.nested.revisions.length + 1);
  assert.deepEqual(
    nextState.nested.revisions.slice(0, state.nested.revisions.length),
    state.nested.revisions,
    "upgrade commit changed historical revisions",
  );
  console.log(JSON.stringify(nextState));
}

async function main() {
  const [mode, argument] = process.argv.slice(2);
  if (mode === "create") {
    assert(argument, "create requires the historical account email");
    await create(argument);
    return;
  }
  const state = await readState();
  if (mode === "verify") {
    await verify(state, argument || "unspecified");
    return;
  }
  if (mode === "commit") {
    await commit(state);
    return;
  }
  if (mode === "websocket-mutate") {
    await mutateThroughWebSocket(state);
    return;
  }
  if (mode === "websocket-hold") {
    await mutateThroughWebSocket(state, { holdUntilDisconnect: true });
    return;
  }
  if (mode === "verify-backup") {
    assert(argument, "verify-backup requires a generation path");
    await verifyBackupWorkingDocument(state, argument);
    return;
  }
  throw new Error(
    "Usage: release-qualification-historical.ts create <email> | verify <stage> | websocket-mutate | websocket-hold | verify-backup <generationPath> | commit",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
