import { expect, test } from "@playwright/test";

test("allows retry and cancellation after a workspace trash request loses its connection", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let attempts = 0;
  await page.route("**/api/workspaces/settings-workspace-e2e/trash", async (route) => {
    attempts += 1;
    expect(route.request().method()).toBe("DELETE");
    expect(route.request().postDataJSON()).toEqual({ confirmationName: "James의 워크스페이스" });
    if (attempts === 1) {
      await route.abort("failed");
    } else {
      await route.fulfill({ status: 409, json: { error: "다시 시도한 요청이 도착했습니다." } });
    }
  });

  await page.goto("/dev/settings-e2e");
  await page.getByRole("button", { name: "휴지통으로 이동", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "워크스페이스를 휴지통으로 옮길까요?" });
  await dialog.getByRole("textbox").fill("James의 워크스페이스");
  const submit = dialog.getByRole("button", { name: "휴지통으로 이동", exact: true });
  await submit.click();
  await expect(dialog.getByRole("alert")).toHaveText("워크스페이스를 휴지통으로 옮기지 못했습니다.");
  await expect(submit).toBeEnabled();
  await expect(dialog.getByRole("textbox")).toHaveValue("James의 워크스페이스");
  await submit.click();
  await expect(dialog.getByRole("alert")).toHaveText("다시 시도한 요청이 도착했습니다.");
  expect(attempts).toBe(2);
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(pageErrors).toEqual([]);
});

test("keeps administration review recoverable when both mutation and reconciliation fail", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let attempts = 0;
  await page.route("**/api/admin-requests/admin-request-e2e", async (route) => {
    attempts += 1;
    expect(route.request().postDataJSON()).toEqual({ decision: "approve", note: "검토 내용을 유지합니다." });
    if (attempts === 1) {
      await route.abort("failed");
    } else {
      await route.fulfill({ status: 409, json: { error: "다른 검토자가 요청을 처리했습니다." } });
    }
  });
  await page.route("**/api/admin-requests", (route) => route.abort("failed"));

  await page.goto("/dev/settings-e2e?adminRequest=1");
  await page.getByRole("button", { name: "승인하고 실행", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "이 관리 요청을 승인할까요?" });
  await dialog.getByRole("textbox").fill("검토 내용을 유지합니다.");
  const submit = dialog.getByRole("button", { name: "승인하고 실행", exact: true });
  await submit.click();
  await expect(dialog.getByRole("alert")).toHaveText("관리 요청을 처리하지 못했습니다.");
  await expect(submit).toBeEnabled();
  await expect(dialog.getByRole("textbox")).toHaveValue("검토 내용을 유지합니다.");
  await submit.click();
  await expect(dialog.getByRole("alert")).toHaveText("다른 검토자가 요청을 처리했습니다.");
  await expect(submit).toBeEnabled();
  expect(attempts).toBe(2);
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "승인하고 실행", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
