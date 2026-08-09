import { expect, test } from "@playwright/test";
import {
  activeRichEditor,
  appendMarker,
  authenticateHardeningOwner,
  captureMaximumUpdateDepthErrors,
  commitCurrentDraft,
  createTopLevelDocument,
  dragDocumentInside,
  navigateThroughTree,
  waitForDraftState,
} from "./helpers";

test("preserves several real dirty drafts through switching and a tree move, then saves each", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const maximumUpdateDepthErrors = captureMaximumUpdateDepthErrors(page);
  await authenticateHardeningOwner(page);

  const runId = `${testInfo.project.name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const documents = [
    await createTopLevelDocument(page, `Hardening ${runId} A`, `baseline A ${runId}`),
    await createTopLevelDocument(page, `Hardening ${runId} B`, `baseline B ${runId}`),
    await createTopLevelDocument(page, `Hardening ${runId} C`, `baseline C ${runId}`),
  ];
  const [documentA, documentB, documentC] = documents;

  // A newly committed document must stay clean after focus and caret-only input.
  await waitForDraftState(page, "clean");
  const cleanEditor = activeRichEditor(page);
  await cleanEditor.click();
  for (const key of ["Home", "End", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
    await page.keyboard.press(key);
  }
  await page.waitForTimeout(1_200);
  await waitForDraftState(page, "clean");
  await expect(page.getByText("초안 저장됨", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "문서 이름" })).toHaveValue(documentC.title, {
    timeout: 30_000,
  });
  await waitForDraftState(page, "clean");

  const markers = new Map([
    [documentA.id, `DIRTY_A_${runId}`],
    [documentB.id, `DIRTY_B_${runId}`],
    [documentC.id, `DIRTY_C_${runId}`],
  ]);
  for (const document of [documentA, documentB, documentC]) {
    await navigateThroughTree(page, document);
    await appendMarker(page, markers.get(document.id)!);
  }

  // Move an inactive dirty document through the real reorder endpoint.
  await dragDocumentInside(page, documentB, documentA);
  await navigateThroughTree(page, documentB);
  await expect(activeRichEditor(page)).toContainText(markers.get(documentB.id)!);
  await waitForDraftState(page, "dirty");

  for (const document of [documentB, documentA, documentC]) {
    if (document.id !== documentB.id) await navigateThroughTree(page, document);
    await expect(activeRichEditor(page)).toContainText(markers.get(document.id)!);
    await waitForDraftState(page, "dirty");
    await commitCurrentDraft(page);
  }

  // Tree navigation after all commits must load canonical content, not a stale local editor value.
  for (const document of [documentA, documentB, documentC]) {
    await navigateThroughTree(page, document);
    await expect(activeRichEditor(page)).toContainText(markers.get(document.id)!);
    await waitForDraftState(page, "clean");
  }
  await page.reload();
  await expect(activeRichEditor(page)).toContainText(markers.get(documentC.id)!, {
    timeout: 30_000,
  });
  await waitForDraftState(page, "clean");
  await page.waitForTimeout(750);
  expect(
    maximumUpdateDepthErrors,
    "The real collaboration lifecycle must not trigger a React render/effect update loop.",
  ).toEqual([]);
});
