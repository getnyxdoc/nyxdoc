import { expect, test, type Page } from "@playwright/test";
import { clickTextOffset, expectCaret } from "./caret-position";

async function openParagraphs(page: Page, ...indices: number[]) {
  await page.goto("/dev/collaboration-e2e?fixture=caret");
  await expect(page.getByTestId("collaboration-ready")).toHaveText("ready");
  const editor = page.getByRole("textbox", { name: "협업 선택 테스트" });
  return indices.map((index) => editor.locator(`[data-nyxdoc-block-id="caret-line-${index}"]`));
}

test("moves vertically from the keyboard column after clicking in the middle", async ({ page }) => {
  const [top, middle, bottom] = await openParagraphs(page, 0, 1, 2);
  await clickTextOffset(middle, 6);
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowDown");
  await expectCaret(bottom, 0);
  await clickTextOffset(middle, 6);
  await page.keyboard.press("ArrowDown");
  await expectCaret(bottom, 6);
  for (let i = 0; i < 6; i++) await page.keyboard.down("ArrowLeft");
  await page.keyboard.up("ArrowLeft");
  await expectCaret(bottom, 0);
  await page.keyboard.press("ArrowUp");
  await expectCaret(middle, 0);
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowUp");
  await expectCaret(top, 4);
});

test("uses Home, End and word navigation as the next vertical column", async ({ page }) => {
  const line = "alpha bravo charlie";
  const [top, bottom] = await openParagraphs(page, 5, 6);
  await clickTextOffset(top, 8);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowUp");
  await expectCaret(top, 0);
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowDown");
  await expectCaret(bottom, line.length);
  await page.keyboard.press("Control+ArrowLeft");
  await expectCaret(bottom, 12);
  await page.keyboard.press("ArrowUp");
  await expectCaret(top, 12);
  await page.keyboard.press("Shift+ArrowRight");
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("c");
  await page.keyboard.press("ArrowRight");
  await expectCaret(top, 13);
  await page.keyboard.press("ArrowDown");
  await expectCaret(bottom, 13);
});

test("recovers the intended column across short lines and resets it on a new click", async ({ page }) => {
  const [top, short, bottom] = await openParagraphs(page, 2, 3, 4);
  await clickTextOffset(top, 4);
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expectCaret(short, 2);
  await page.keyboard.press("ArrowDown");
  await expectCaret(bottom, 9);
  await clickTextOffset(bottom, 6);
  await page.keyboard.press("ArrowUp");
  await expectCaret(short, 2);
  await page.keyboard.press("ArrowUp");
  await expectCaret(top, 6);
});

test("moves between wrapped visual lines from the updated horizontal position", async ({ page }) => {
  const [paragraph] = await openParagraphs(page, 7);
  // Force wrapping even on wide viewports, then measure the actual line break.
  await paragraph.evaluate((element) => {
    Object.assign(element.style, { font: "20px/32px monospace", width: "10ch", wordBreak: "break-all" });
  });
  const nextLine = await paragraph.evaluate((element) => {
    const text = element.querySelector("[data-slate-string]")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const firstTop = range.getBoundingClientRect().top;
    for (let i = 1; i < text.textContent!.length; i++) {
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      if (range.getBoundingClientRect().top > firstTop + 1) return i;
    }
    throw new Error("Expected a wrapped line");
  });
  await clickTextOffset(paragraph, 2);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowDown");
  await expectCaret(paragraph, nextLine + 1);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowUp");
  await expectCaret(paragraph, 2);
});
