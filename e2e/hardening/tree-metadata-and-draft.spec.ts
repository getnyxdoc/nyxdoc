import { expect, test, type Page } from "@playwright/test";
import {
  activeRichEditor,
  appendMarker,
  authenticateHardeningOwner,
  captureMaximumUpdateDepthErrors,
  createTopLevelDocument,
  documentTree,
  dragDocumentInside,
  navigateThroughTree,
  waitForDraftState,
  type CreatedDocument,
} from "./helpers";

type TreeDocument = {
  id: string;
  parentDocumentId: string | null;
  revisionNumber: number;
  title: string;
  treeOrder: number;
};

type WorkingDocumentState = {
  committedDraftVersion: number;
  draftVersion: number;
  hasUncommittedChanges: boolean;
  revisionNumber: number;
  title: string;
};

type DropPosition = "before" | "inside" | "after";

async function readTree(page: Page): Promise<TreeDocument[]> {
  return page.evaluate(async () => {
    const response = await fetch("/api/documents", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`Document list failed with ${response.status}.`);
    const body = await response.json() as { documents?: unknown };
    if (!Array.isArray(body.documents)) throw new Error("Document list did not include documents.");

    return body.documents.map((value) => {
      const document = value as Partial<{
        id: unknown;
        parentDocumentId: unknown;
        revisionNumber: unknown;
        title: unknown;
        treeOrder: unknown;
      }>;
      if (
        typeof document.id !== "string"
        || (typeof document.parentDocumentId !== "string" && document.parentDocumentId !== null)
        || !Number.isInteger(document.revisionNumber)
        || typeof document.title !== "string"
        || !Number.isFinite(document.treeOrder)
      ) {
        throw new Error("Document list returned an invalid tree document.");
      }
      return {
        id: document.id,
        parentDocumentId: typeof document.parentDocumentId === "string"
          ? document.parentDocumentId
          : null,
        revisionNumber: Number(document.revisionNumber),
        title: document.title,
        treeOrder: Number(document.treeOrder),
      };
    });
  });
}

async function readWorkingState(page: Page, documentId: string): Promise<WorkingDocumentState> {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/documents/${encodeURIComponent(id)}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`Document state failed with ${response.status}.`);
    const body = await response.json() as {
      document?: { revisionNumber?: unknown; title?: unknown };
      workingDocument?: {
        committedDraftVersion?: unknown;
        draftVersion?: unknown;
        hasUncommittedChanges?: unknown;
      };
    };
    const document = body.document;
    const workingDocument = body.workingDocument;
    if (
      !document
      || !workingDocument
      || !Number.isInteger(document.revisionNumber)
      || typeof document.title !== "string"
      || !Number.isInteger(workingDocument.committedDraftVersion)
      || !Number.isInteger(workingDocument.draftVersion)
      || typeof workingDocument.hasUncommittedChanges !== "boolean"
    ) {
      throw new Error("Document state did not include the current draft metadata.");
    }
    return {
      revisionNumber: Number(document.revisionNumber),
      title: document.title,
      committedDraftVersion: Number(workingDocument.committedDraftVersion),
      draftVersion: Number(workingDocument.draftVersion),
      hasUncommittedChanges: workingDocument.hasUncommittedChanges,
    };
  }, documentId);
}

function childIds(tree: TreeDocument[], parentDocumentId: string | null) {
  return tree
    .filter((document) => document.parentDocumentId === parentDocumentId)
    .sort((left, right) => left.treeOrder - right.treeOrder)
    .map((document) => document.id);
}

function expectRelativeOrder(ids: string[], beforeId: string, afterId: string) {
  expect(ids.indexOf(beforeId), `${beforeId} must be present in the sibling order`).toBeGreaterThanOrEqual(0);
  expect(ids.indexOf(afterId), `${afterId} must be present in the sibling order`).toBeGreaterThanOrEqual(0);
  expect(ids.indexOf(beforeId), `${beforeId} must precede ${afterId}`).toBeLessThan(ids.indexOf(afterId));
}

async function expectSubtreePreserved(
  page: Page,
  parent: CreatedDocument,
  leaves: readonly CreatedDocument[],
) {
  const tree = await readTree(page);
  expect(childIds(tree, parent.id)).toEqual(leaves.map((leaf) => leaf.id));

  const treeNavigation = documentTree(page);
  const parentRow = treeNavigation.locator(`[data-document-id="${parent.id}"]`);
  await expect(parentRow).toBeVisible();
  for (const leaf of leaves) {
    const leafRow = treeNavigation.locator(`[data-document-id="${leaf.id}"]`);
    await expect(leafRow).toBeVisible();
    const [parentIndent, leafIndent] = await Promise.all([
      parentRow.evaluate((element) => Number.parseFloat((element as HTMLElement).style.paddingLeft)),
      leafRow.evaluate((element) => Number.parseFloat((element as HTMLElement).style.paddingLeft)),
    ]);
    expect(leafIndent).toBeGreaterThan(parentIndent);
  }
}

async function dragDocumentToPosition(
  page: Page,
  source: CreatedDocument,
  target: CreatedDocument,
  position: DropPosition,
) {
  const tree = documentTree(page);
  const sourceRow = tree.locator(`[data-document-id="${source.id}"]`);
  const targetRow = tree.locator(`[data-document-id="${target.id}"]`);
  await expect(sourceRow).toBeVisible();
  await expect(targetRow).toBeVisible();

  const [sourceBox, initialTargetBox, treeBox] = await Promise.all([
    sourceRow.boundingBox(),
    targetRow.boundingBox(),
    tree.boundingBox(),
  ]);
  if (!sourceBox || !initialTargetBox || !treeBox) {
    throw new Error("Document tree drag coordinates were unavailable.");
  }

  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/documents/${source.id}/reorder`)
  ));
  const targetRatio = position === "before" ? 0.14 : position === "after" ? 0.86 : 0.5;
  const sourcePoint = {
    x: sourceBox.x + Math.min(120, Math.max(20, sourceBox.width / 2)),
    y: sourceBox.y + sourceBox.height / 2,
  };

  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  await page.mouse.down();
  await page.mouse.move(sourcePoint.x + 10, sourcePoint.y, { steps: 4 });

  // A deep expanded subtree can push the destination just below the visible
  // tree viewport. Exercise the product's edge auto-scroll while keeping the
  // pointer inside the real drop surface, just as a person would.
  let targetBox = initialTargetBox;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const aboveViewport = targetBox.y < treeBox.y + 4;
    const belowViewport = targetBox.y + targetBox.height > treeBox.y + treeBox.height - 4;
    if (!aboveViewport && !belowViewport) break;
    const edgeY = aboveViewport ? treeBox.y + 8 : treeBox.y + treeBox.height - 8;
    await page.mouse.move(
      treeBox.x + Math.min(120, Math.max(20, treeBox.width / 2)) + (attempt % 2),
      edgeY,
      { steps: 2 },
    );
    await page.waitForTimeout(20);
    const nextTargetBox = await targetRow.boundingBox();
    if (!nextTargetBox) throw new Error("The destination left the document tree during auto-scroll.");
    targetBox = nextTargetBox;
  }
  expect(targetBox.y).toBeGreaterThanOrEqual(treeBox.y);
  expect(targetBox.y + targetBox.height).toBeLessThanOrEqual(treeBox.y + treeBox.height);
  const targetPoint = {
    x: targetBox.x + Math.min(120, Math.max(20, targetBox.width / 2)),
    y: targetBox.y + targetBox.height * targetRatio,
  };
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 14 });
  await page.mouse.up();

  const response = await responsePromise;
  expect(response.ok(), `tree move ${position} response`).toBe(true);
  expect(response.request().postDataJSON()).toEqual({
    requestId: expect.stringMatching(/^tree-reorder-/),
    targetDocumentId: target.id,
    position,
  });
  const body = await response.json() as {
    documents?: unknown;
    parentDocumentId?: unknown;
    position?: unknown;
  };
  expect(body).toMatchObject({
    parentDocumentId: position === "inside" ? target.id : expect.anything(),
    position,
  });
  expect(Array.isArray(body.documents)).toBe(true);
}

async function openRenameDialog(page: Page, document: CreatedDocument) {
  const tree = documentTree(page);
  const row = tree.locator(`[data-document-id="${document.id}"]`);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: `${document.title} 메뉴`, exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "문서 이름 변경", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "문서 이름 변경" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("preserves deep subtrees and dirty bodies while parent moves create metadata revisions", async ({
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  const maximumUpdateDepthErrors = captureMaximumUpdateDepthErrors(page);
  const runId = `${testInfo.project.name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  let phase = "authenticate";

  try {
    await authenticateHardeningOwner(page);

    phase = "create documents through the real UI";
    const root = await createTopLevelDocument(page, `Tree root ${runId}`, `root ${runId}`);
    const source = await createTopLevelDocument(page, `Tree source ${runId}`, `source ${runId}`);
    const deep = await createTopLevelDocument(page, `Tree deep ${runId}`, `deep ${runId}`);
    const leafOne = await createTopLevelDocument(page, `Tree leaf one ${runId}`, `leaf one ${runId}`);
    const leafTwo = await createTopLevelDocument(page, `Tree leaf two ${runId}`, `leaf two ${runId}`);
    const siblingBefore = await createTopLevelDocument(page, `Tree before ${runId}`, `before ${runId}`);
    const destination = await createTopLevelDocument(page, `Tree destination ${runId}`, `destination ${runId}`);
    const siblingAfter = await createTopLevelDocument(page, `Tree after ${runId}`, `after ${runId}`);

    phase = "assemble a three-level tree with siblings";
    await dragDocumentInside(page, source, root);
    await dragDocumentInside(page, deep, source);
    await dragDocumentInside(page, leafOne, deep);
    await dragDocumentInside(page, leafTwo, deep);
    await dragDocumentInside(page, siblingBefore, root);
    await dragDocumentInside(page, destination, root);
    await dragDocumentInside(page, siblingAfter, root);

    const initialTree = await readTree(page);
    expect(childIds(initialTree, root.id)).toEqual([
      source.id,
      siblingBefore.id,
      destination.id,
      siblingAfter.id,
    ]);
    expect(childIds(initialTree, source.id)).toEqual([deep.id]);
    await expectSubtreePreserved(page, deep, [leafOne, leafTwo]);

    const rootRow = documentTree(page).locator(`[data-document-id="${root.id}"]`);
    const sourceRow = documentTree(page).locator(`[data-document-id="${source.id}"]`);
    const deepRow = documentTree(page).locator(`[data-document-id="${deep.id}"]`);
    const [rootIndent, sourceIndent, deepIndent] = await Promise.all([
      rootRow.evaluate((element) => Number.parseFloat((element as HTMLElement).style.paddingLeft)),
      sourceRow.evaluate((element) => Number.parseFloat((element as HTMLElement).style.paddingLeft)),
      deepRow.evaluate((element) => Number.parseFloat((element as HTMLElement).style.paddingLeft)),
    ]);
    expect(sourceIndent).toBeGreaterThan(rootIndent);
    expect(deepIndent).toBeGreaterThan(sourceIndent);

    phase = "make the moved deep subtree dirty";
    await navigateThroughTree(page, deep);
    const dirtyMarker = `DIRTY_DEEP_SUBTREE_${runId}`;
    await appendMarker(page, dirtyMarker);
    const dirtyBeforeMove = await readWorkingState(page, deep.id);
    expect(dirtyBeforeMove.hasUncommittedChanges).toBe(true);
    expect(dirtyBeforeMove.draftVersion).toBeGreaterThan(dirtyBeforeMove.committedDraftVersion);
    const dirtyMoveFailures: string[] = [];
    let expectedRevision = dirtyBeforeMove.revisionNumber;
    let previousDraftVersion = dirtyBeforeMove.draftVersion;
    const recordDirtyMoveState = async (position: DropPosition) => {
      const state = await readWorkingState(page, deep.id);
      expectedRevision += 1;
      if (state.revisionNumber !== expectedRevision) {
        dirtyMoveFailures.push(
          `${position}: expected metadata revision ${expectedRevision}, received ${state.revisionNumber}`,
        );
      }
      if (state.committedDraftVersion !== dirtyBeforeMove.committedDraftVersion) {
        dirtyMoveFailures.push(
          `${position}: committed draft version changed ${dirtyBeforeMove.committedDraftVersion} → ${state.committedDraftVersion}`,
        );
      }
      if (state.draftVersion < previousDraftVersion) {
        dirtyMoveFailures.push(
          `${position}: draft version regressed ${previousDraftVersion} → ${state.draftVersion}`,
        );
      }
      previousDraftVersion = state.draftVersion;
      if (!state.hasUncommittedChanges) {
        dirtyMoveFailures.push(`${position}: dirty draft became clean.`);
      }
      await navigateThroughTree(page, deep);
      const content = await activeRichEditor(page).textContent();
      if (!content?.includes(dirtyMarker)) {
        dirtyMoveFailures.push(`${position}: dirty draft body marker was lost.`);
      }
      if (await page.getByText("초안 저장됨", { exact: true }).count() === 0) {
        dirtyMoveFailures.push(`${position}: UI no longer marks the document as a saved draft.`);
      }
    };

    phase = "move the dirty deep subtree before a sibling";
    await dragDocumentToPosition(page, deep, siblingBefore, "before");
    let tree = await readTree(page);
    expect(childIds(tree, root.id)).toContain(deep.id);
    expectRelativeOrder(childIds(tree, root.id), deep.id, siblingBefore.id);
    await expectSubtreePreserved(page, deep, [leafOne, leafTwo]);

    await recordDirtyMoveState("before");

    phase = "move the same dirty deep subtree inside another sibling";
    await dragDocumentToPosition(page, deep, destination, "inside");
    tree = await readTree(page);
    expect(childIds(tree, destination.id)).toEqual([deep.id]);
    await expectSubtreePreserved(page, deep, [leafOne, leafTwo]);
    await recordDirtyMoveState("inside");

    phase = "move the same dirty deep subtree after a sibling";
    await dragDocumentToPosition(page, deep, siblingAfter, "after");
    tree = await readTree(page);
    expect(childIds(tree, root.id)).toContain(deep.id);
    expectRelativeOrder(childIds(tree, root.id), siblingAfter.id, deep.id);
    await expectSubtreePreserved(page, deep, [leafOne, leafTwo]);
    await recordDirtyMoveState("after");
    expect(
      dirtyMoveFailures,
      "A parent move must create exactly one metadata revision without committing or discarding the dirty body.",
    ).toEqual([]);

    expect(
      maximumUpdateDepthErrors,
      "Tree movement and inactive metadata updates must not create a React update loop.",
    ).toEqual([]);
  } catch (error) {
    await testInfo.attach("tree-metadata-and-draft-reproduction", {
      body: Buffer.from(JSON.stringify({
        browser: testInfo.project.name,
        failedPhase: phase,
        reproduction: [
          "Create top-level root, source, deep, two leaves, four sibling documents, and a rename target.",
          "Build root → source → deep → leaves, then give root four sibling children.",
          "Add an unsaved marker to deep and move that subtree before, inside, and after sibling targets.",
          "Verify leaves retain their parent/order, the marker remains, and each parent change creates one metadata revision.",
        ],
      }, null, 2)),
      contentType: "application/json",
    });
    throw error;
  }
});

test("uses a freshly fetched draftVersion for inactive tree renames and never commits a dirty draft", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const runId = `${testInfo.project.name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  let phase = "authenticate";

  try {
    await authenticateHardeningOwner(page);
    phase = "create active and inactive documents";
    const activeDocument = await createTopLevelDocument(page, `Rename active ${runId}`, `active ${runId}`);
    const cleanRenameTarget = await createTopLevelDocument(
      page,
      `Rename clean ${runId}`,
      `clean ${runId}`,
    );
    const dirtyRenameTarget = await createTopLevelDocument(
      page,
      `Rename dirty ${runId}`,
      `dirty ${runId}`,
    );

    phase = "rename an inactive clean document using its fetched current draft version";
    await navigateThroughTree(page, activeDocument);
    const cleanRenameTitle = `${cleanRenameTarget.title} renamed`;
    let dialog = await openRenameDialog(page, cleanRenameTarget);
    await dialog.locator("input").fill(cleanRenameTitle);
    const cleanCurrentStateResponse = page.waitForResponse((response) => (
      response.request().method() === "GET"
      && response.url().endsWith(`/api/documents/${cleanRenameTarget.id}`)
    ));
    const cleanRenameResponse = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && response.url().endsWith(`/api/documents/${cleanRenameTarget.id}`)
    ));
    await dialog.getByRole("button", { name: "이름 변경", exact: true }).click();
    const [cleanCurrentResponse, cleanSaveResponse] = await Promise.all([
      cleanCurrentStateResponse,
      cleanRenameResponse,
    ]);
    expect(cleanSaveResponse.ok()).toBe(true);
    const cleanCurrentBody = await cleanCurrentResponse.json() as {
      workingDocument?: { draftVersion?: unknown };
    };
    const cleanRenamePayload = cleanSaveResponse.request().postDataJSON() as {
      expectedDraftVersion?: unknown;
    };
    expect(cleanRenamePayload.expectedDraftVersion).toBe(cleanCurrentBody.workingDocument?.draftVersion);
    await expect(dialog).toBeHidden();
    await expect(
      documentTree(page)
        .locator(`[data-document-id="${cleanRenameTarget.id}"]`)
        .getByText(cleanRenameTitle, { exact: true }),
    ).toBeVisible();
    await expect.poll(() => readWorkingState(page, cleanRenameTarget.id)).toMatchObject({
      title: cleanRenameTitle,
      hasUncommittedChanges: false,
    });

    phase = "reject inactive dirty-document rename without committing its draft";
    await navigateThroughTree(page, dirtyRenameTarget);
    const renameDraftMarker = `DIRTY_RENAME_${runId}`;
    await appendMarker(page, renameDraftMarker);
    const dirtyRenameBefore = await readWorkingState(page, dirtyRenameTarget.id);
    await navigateThroughTree(page, activeDocument);
    dialog = await openRenameDialog(page, dirtyRenameTarget);
    const rejectedTitle = `${dirtyRenameTarget.title} rejected`;
    await dialog.locator("input").fill(rejectedTitle);
    const dirtyCurrentStateResponse = page.waitForResponse((response) => (
      response.request().method() === "GET"
      && response.url().endsWith(`/api/documents/${dirtyRenameTarget.id}`)
    ));
    const dirtyRenameResponse = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && response.url().endsWith(`/api/documents/${dirtyRenameTarget.id}`)
    ));
    await dialog.getByRole("button", { name: "이름 변경", exact: true }).click();
    const [dirtyCurrentResponse, dirtySaveResponse] = await Promise.all([
      dirtyCurrentStateResponse,
      dirtyRenameResponse,
    ]);
    expect(dirtySaveResponse.status()).toBe(409);
    const dirtyCurrentBody = await dirtyCurrentResponse.json() as {
      workingDocument?: { draftVersion?: unknown };
    };
    const dirtyRenamePayload = dirtySaveResponse.request().postDataJSON() as {
      expectedDraftVersion?: unknown;
    };
    expect(dirtyRenamePayload.expectedDraftVersion).toBe(dirtyCurrentBody.workingDocument?.draftVersion);
    await expect(dialog.getByText("문서가 먼저 변경되었습니다. 최신 내용을 확인한 뒤 다시 시도해주세요.", { exact: true }))
      .toBeVisible();
    await dialog.getByRole("button", { name: "닫기", exact: true }).click();

    const dirtyRenameAfter = await readWorkingState(page, dirtyRenameTarget.id);
    expect(dirtyRenameAfter).toMatchObject({
      title: dirtyRenameTarget.title,
      revisionNumber: dirtyRenameBefore.revisionNumber,
      draftVersion: dirtyRenameBefore.draftVersion,
      committedDraftVersion: dirtyRenameBefore.committedDraftVersion,
      hasUncommittedChanges: true,
    });
    await navigateThroughTree(page, dirtyRenameTarget);
    await expect(activeRichEditor(page)).toContainText(renameDraftMarker);
    await waitForDraftState(page, "dirty");
  } catch (error) {
    await testInfo.attach("inactive-rename-cas-reproduction", {
      body: Buffer.from(JSON.stringify({
        browser: testInfo.project.name,
        failedPhase: phase,
        reproduction: [
          "Create two documents and keep the first active.",
          "Rename the inactive clean document through its tree menu and compare the GET and PUT draft versions.",
          "Edit the renamed document without saving, switch back to the first document, and retry rename through the tree menu.",
          "Verify the retry returns DRAFT_CONFLICT, keeps the title, canonical revision, and draft versions unchanged, and preserves the body marker.",
        ],
      }, null, 2)),
      contentType: "application/json",
    });
    throw error;
  }
});
