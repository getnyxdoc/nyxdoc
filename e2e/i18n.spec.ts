import { expect, test } from "@playwright/test";

test.describe("English browser locale", () => {
  test.use({ locale: "en-US" });

  test("renders the public and authentication surfaces in English", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { name: /Ask in conversation/ })).toBeVisible();
    await page.getByRole("link", { name: "Open my workspace" }).click();
    await expect(page.getByRole("heading", { name: "Continue where you left off." })).toBeVisible();
  });
});

test.describe("Japanese browser locale", () => {
  test.use({ locale: "ja-JP" });

  test("renders the public and authentication surfaces in Japanese", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page.getByRole("heading", { name: /会話で依頼して/ })).toBeVisible();
    await page.getByRole("link", { name: "ワークスペースを開く" }).click();
    await expect(page.getByRole("heading", { name: "続きから始めましょう。" })).toBeVisible();
  });
});
