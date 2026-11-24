import { expect, type Locator } from "@playwright/test";

export async function clickTextOffset(paragraph: Locator, offset: number) {
  await paragraph.scrollIntoViewIfNeeded();
  const point = await paragraph.evaluate((element, index) => {
    const text = element.querySelector("[data-slate-string]")?.firstChild;
    if (!(text instanceof Text)) throw new Error("Expected a text leaf");
    const range = document.createRange();
    range.setStart(text, index);
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y + rect.height / 2 };
  }, offset);
  await paragraph.page().mouse.click(point.x, point.y);
  await expectCaret(paragraph, offset);
}

export async function expectCaret(paragraph: Locator, offset: number) {
  await expect.poll(() => paragraph.evaluate((element) => {
    const selection = window.getSelection();
    if (!selection?.isCollapsed || !element.contains(selection.focusNode)) return null;
    return selection.focusOffset;
  })).toBe(offset);
}
