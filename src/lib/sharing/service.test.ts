import { afterEach, describe, expect, it } from "vitest";
import type { NyxDatabase } from "@/lib/db/client";
import { listDocuments } from "@/lib/documents/service";
import {
  disableDocumentPublicShare,
  enableDocumentPublicShare,
  getDocumentPublicShare,
  getPublicSharedDocument,
  PublicShareError,
} from "@/lib/sharing/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("document public sharing", () => {
  it("shares one canonical document, revokes immediately, and reuses its link", () => {
    const database = createTestDatabase();
    databases.push(database);
    const owner = createTestUser(database, { name: "James" });
    const document = listDocuments(database, owner.workspace.id)[0];

    expect(getDocumentPublicShare(database, owner.workspace.id, document.id)).toBeNull();
    const first = enableDocumentPublicShare(database, {
      workspaceId: owner.workspace.id,
      documentId: document.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
    });
    expect(first.enabled).toBe(true);
    expect(getPublicSharedDocument(database, first.publicToken).document.id).toBe(document.id);

    const disabled = disableDocumentPublicShare(database, {
      workspaceId: owner.workspace.id,
      documentId: document.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
    });
    expect(disabled?.enabled).toBe(false);
    expect(() => getPublicSharedDocument(database, first.publicToken))
      .toThrow(PublicShareError);

    const reenabled = enableDocumentPublicShare(database, {
      workspaceId: owner.workspace.id,
      documentId: document.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
    });
    expect(reenabled.publicToken).toBe(first.publicToken);
    expect(reenabled.enabled).toBe(true);
  });

  it("enforces the document workspace boundary", () => {
    const database = createTestDatabase();
    databases.push(database);
    const first = createTestUser(database, { name: "First" });
    const second = createTestUser(database, { name: "Second" });
    const foreignDocument = listDocuments(database, second.workspace.id)[0];

    expect(() => enableDocumentPublicShare(database, {
      workspaceId: first.workspace.id,
      documentId: foreignDocument.id,
      userId: first.user.id,
      actorLabel: first.user.name,
    })).toThrow(/문서를 찾을 수 없습니다/);
  });
});
