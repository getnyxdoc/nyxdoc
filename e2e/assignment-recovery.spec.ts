import { expect, test } from "@playwright/test";

// Browser interaction contract: the assignment API is mocked to exercise an
// interrupted request and a retry; this is not a persistence/integration test.
test("keeps assignment input and permits retry after a network failure", async ({ page }) => {
  const requests: unknown[] = [];
  await page.route("**/api/assignments", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      await route.abort("failed");
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ assignment: { id: "assignment-retry-e2e" } }),
    });
  });

  await page.goto("/dev/workspace-e2e");
  await page.getByRole("button", { name: "담당", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "담당 에이전트", exact: true });
  const agent = dialog.getByRole("combobox", { name: "에이전트", exact: true });
  const role = dialog.getByRole("combobox", { name: "역할", exact: true });
  const note = dialog.getByRole("textbox", { name: /메모/ });
  const submit = dialog.getByRole("button", { name: "담당 지정", exact: true });

  await agent.selectOption("00000000-0000-4000-8000-0000000000a1");
  await role.selectOption("reviewer");
  await note.fill("중단되어도 유지되는 검토 요청");
  await submit.click();

  await expect(dialog.getByRole("alert")).toHaveText("담당 에이전트를 지정하지 못했습니다.");
  await expect(dialog).toBeVisible();
  await expect(submit).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "닫기", exact: true }).first()).toBeEnabled();
  await expect(agent).toHaveValue("00000000-0000-4000-8000-0000000000a1");
  await expect(role).toHaveValue("reviewer");
  await expect(note).toHaveValue("중단되어도 유지되는 검토 요청");

  await submit.click();
  await expect(note).toHaveValue("");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(requests).toEqual(Array(2).fill({
    documentId: "document-e2e",
    agentId: "00000000-0000-4000-8000-0000000000a1",
    assignmentType: "reviewer",
    note: "중단되어도 유지되는 검토 요청",
  }));
});
