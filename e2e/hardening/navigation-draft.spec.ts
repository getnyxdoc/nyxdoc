import { expect, test, type Page } from "@playwright/test";
import {
  activeRichEditor,
  appendMarker,
  authenticateHardeningOwner,
  captureMaximumUpdateDepthErrors,
  commitCurrentDraft,
  createTopLevelDocument,
  documentTree,
  dragDocumentInside,
  navigateThroughTree,
  waitForDraftState,
} from "./helpers";

type StaleDocumentSnapshot = {
  baseRevision: number;
  draftVersion: number;
  title: string;
};

async function readStaleDocumentSnapshot(
  page: Page,
  documentId: string,
): Promise<StaleDocumentSnapshot> {
  return page.evaluate(async (id) => {
    const documentsResponse = await fetch("/api/documents", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!documentsResponse.ok) {
      throw new Error(`Document list failed with ${documentsResponse.status}.`);
    }
    const documentsBody = await documentsResponse.json() as {
      documents?: Array<{
        id?: unknown;
        revisionNumber?: unknown;
        title?: unknown;
      }>;
    };
    const document = documentsBody.documents?.find((item) => item.id === id);
    if (
      !document
      || !Number.isInteger(document.revisionNumber)
      || typeof document.title !== "string"
    ) {
      throw new Error("The stale tab could not resolve the document revision.");
    }

    const collaborationResponse = await fetch("/api/collaboration/token", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentId: id }),
    });
    if (!collaborationResponse.ok) {
      throw new Error(`Collaboration metadata failed with ${collaborationResponse.status}.`);
    }
    const collaborationBody = await collaborationResponse.json() as {
      draftVersion?: unknown;
    };
    if (!Number.isInteger(collaborationBody.draftVersion)) {
      throw new Error("The stale tab did not receive a draft version.");
    }

    return {
      baseRevision: Number(document.revisionNumber),
      draftVersion: Number(collaborationBody.draftVersion),
      title: document.title,
    };
  }, documentId);
}

async function submitStaleTabSave(
  page: Page,
  documentId: string,
  snapshot: StaleDocumentSnapshot,
) {
  return page.evaluate(async ({ id, observed }) => {
    const response = await fetch(`/api/documents/${encodeURIComponent(id)}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: observed.baseRevision,
        expectedDraftVersion: observed.draftVersion,
        title: observed.title,
      }),
    });
    const body = await response.json().catch(() => ({})) as {
      code?: unknown;
      error?: unknown;
    };
    return {
      code: typeof body.code === "string" ? body.code : null,
      error: typeof body.error === "string" ? body.error : null,
      status: response.status,
    };
  }, { id: documentId, observed: snapshot });
}

test("preserves navigation, per-document drafts, tree state, reloads, and stale-save safety", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const maximumUpdateDepthErrors = captureMaximumUpdateDepthErrors(page);
  let phase = "authenticate";

  try {
    await authenticateHardeningOwner(page);

    const runId = `${testInfo.project.name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    phase = "create real documents";
    const parent = await createTopLevelDocument(
      page,
      `Navigation parent ${runId}`,
      `parent baseline ${runId}`,
    );
    const child = await createTopLevelDocument(
      page,
      `Navigation child ${runId}`,
      `child baseline ${runId}`,
    );
    const anchor = await createTopLevelDocument(
      page,
      `Navigation anchor ${runId}`,
      `anchor baseline ${runId}`,
    );

    phase = "move child and persist the collapsed tree state";
    await dragDocumentInside(page, child, parent);
    const tree = documentTree(page);
    const collapseParent = tree.getByRole("button", {
      name: `${parent.title} 접기`,
      exact: true,
    });
    await expect(collapseParent).toHaveAttribute("aria-expanded", "true");
    await collapseParent.click();
    await expect(tree.getByRole("button", {
      name: `${parent.title} 펼치기`,
      exact: true,
    })).toHaveAttribute("aria-expanded", "false");
    await expect(tree.getByRole("link", { name: child.title, exact: true })).toHaveCount(0);

    await navigateThroughTree(page, anchor);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "문서 이름" })).toHaveValue(anchor.title, {
      timeout: 30_000,
    });
    await expect(tree.getByRole("button", {
      name: `${parent.title} 펼치기`,
      exact: true,
    })).toHaveAttribute("aria-expanded", "false");
    await expect(tree.getByRole("link", { name: child.title, exact: true })).toHaveCount(0);

    phase = "read and move the caret without creating a draft";
    await waitForDraftState(page, "clean");
    const cleanEditor = activeRichEditor(page);
    await cleanEditor.click();
    for (const key of ["Home", "End", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      await page.keyboard.press(key);
    }
    await page.waitForTimeout(1_200);
    await waitForDraftState(page, "clean");
    await expect(page.getByText("초안 저장됨", { exact: true })).toHaveCount(0);

    phase = "keep two unsaved drafts while navigating";
    const parentMarker = `UNSAVED_PARENT_${runId}`;
    const anchorMarker = `UNSAVED_ANCHOR_${runId}`;
    await navigateThroughTree(page, parent);
    await appendMarker(page, parentMarker);
    await navigateThroughTree(page, anchor);
    await appendMarker(page, anchorMarker);

    await navigateThroughTree(page, parent);
    await expect(activeRichEditor(page)).toContainText(parentMarker);
    await waitForDraftState(page, "dirty");
    await page.reload();
    await expect(page.getByRole("textbox", { name: "문서 이름" })).toHaveValue(parent.title, {
      timeout: 30_000,
    });
    await expect(activeRichEditor(page)).toContainText(parentMarker, { timeout: 30_000 });
    await waitForDraftState(page, "dirty");

    await navigateThroughTree(page, anchor);
    await expect(activeRichEditor(page)).toContainText(anchorMarker);
    await waitForDraftState(page, "dirty");

    phase = "commit each retained draft";
    await commitCurrentDraft(page);
    await navigateThroughTree(page, parent);
    await commitCurrentDraft(page);
    await navigateThroughTree(page, anchor);
    await waitForDraftState(page, "clean");

    phase = "reject a stale tab save without losing the current draft";
    const staleTab = await context.newPage();
    await staleTab.goto(anchor.href);
    await expect(staleTab.getByRole("textbox", { name: "문서 이름" })).toHaveValue(anchor.title, {
      timeout: 30_000,
    });
    await expect(activeRichEditor(staleTab)).toBeVisible();
    await waitForDraftState(staleTab, "clean");
    const staleSnapshot = await readStaleDocumentSnapshot(staleTab, anchor.id);

    const currentMarker = `CURRENT_AFTER_STALE_${runId}`;
    await appendMarker(page, currentMarker);
    const staleResult = await submitStaleTabSave(staleTab, anchor.id, staleSnapshot);
    expect(staleResult.status).toBe(409);
    expect(staleResult.code).toBe("DRAFT_CONFLICT");
    await expect(activeRichEditor(page)).toContainText(currentMarker);
    await waitForDraftState(page, "dirty");

    await commitCurrentDraft(page);
    await staleTab.reload();
    await expect(activeRichEditor(staleTab)).toContainText(currentMarker, { timeout: 30_000 });
    await waitForDraftState(staleTab, "clean");
    await staleTab.close();

    phase = "final reload and tree-state verification";
    await page.reload();
    await expect(activeRichEditor(page)).toContainText(currentMarker, { timeout: 30_000 });
    await waitForDraftState(page, "clean");
    await expect(tree.getByRole("button", {
      name: `${parent.title} 펼치기`,
      exact: true,
    })).toHaveAttribute("aria-expanded", "false");
    expect(
      maximumUpdateDepthErrors,
      "Navigation and draft lifecycle must not enter a React update loop.",
    ).toEqual([]);
  } catch (error) {
    await testInfo.attach("navigation-draft-reproduction", {
      body: Buffer.from(JSON.stringify({
        browser: testInfo.project.name,
        failedPhase: phase,
        reproduction: [
          "Create a parent, child, and unrelated document through the real UI.",
          "Move the child inside the parent, collapse the parent, navigate, and reload.",
          "Move only the caret in a clean document and verify no draft appears.",
          "Edit two documents without committing and navigate/reload between them.",
          "Commit both, then submit an older observed draft version from a second tab.",
          "Verify the stale save is rejected and the current draft remains intact.",
        ],
      }, null, 2)),
      contentType: "application/json",
    });
    throw error;
  }
});
