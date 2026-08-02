import { describe, expect, it } from "vitest";
import {
  CaretTraceRecorder,
  detectCaretAnomaly,
  diagnosticKey,
} from "@/lib/editor/caret-trace";
import type { CaretSelectionSnapshot } from "@/lib/editor/diagnostics";

function tableSelection(rowIndex: number, columnIndex: number): CaretSelectionSnapshot {
  return {
    kind: "text",
    collapsed: true,
    anchor: { path: [4, rowIndex, columnIndex, 0, 0], offset: 3 },
    focus: { path: [4, rowIndex, columnIndex, 0, 0], offset: 3 },
    table: { blockIndex: 4, rowIndex, columnIndex },
    selectedCellCount: 0,
  };
}

describe("caret trace anomaly detection", () => {
  it("flags a text mutation that unexpectedly moves to another table cell", () => {
    expect(detectCaretAnomaly({
      previous: tableSelection(1, 1),
      current: tableSelection(1, 2),
      intent: { elapsedMs: 100, inputType: "insertText", kind: "beforeinput" },
      elapsedMs: 130,
      composing: false,
    })).toBe("table_cell_changed");
  });

  it("does not flag intentional Tab and pointer movement between cells", () => {
    expect(detectCaretAnomaly({
      previous: tableSelection(1, 1),
      current: tableSelection(1, 2),
      intent: { elapsedMs: 100, key: "tab", kind: "keydown" },
      elapsedMs: 130,
      composing: false,
    })).toBeNull();
    expect(detectCaretAnomaly({
      previous: tableSelection(1, 1),
      current: tableSelection(2, 2),
      intent: { elapsedMs: 100, kind: "pointer" },
      elapsedMs: 130,
      composing: false,
    })).toBeNull();
  });

  it("flags an input-driven jump to the first document position", () => {
    const previous: CaretSelectionSnapshot = {
      kind: "text",
      collapsed: true,
      anchor: { path: [7, 0], offset: 9 },
      focus: { path: [7, 0], offset: 9 },
      selectedCellCount: 0,
    };
    const current: CaretSelectionSnapshot = {
      kind: "text",
      collapsed: true,
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 0 },
      selectedCellCount: 0,
    };
    expect(detectCaretAnomaly({
      previous,
      current,
      intent: { elapsedMs: 200, inputType: "insertText", kind: "beforeinput" },
      elapsedMs: 220,
      composing: false,
    })).toBe("jumped_to_document_start");
  });

  it("keeps a bounded trace and detects a focused editor remount", () => {
    let now = 1_000;
    const recorder = new CaretTraceRecorder("document", () => now);
    expect(recorder.record({
      kind: "editor_mount",
      composing: false,
      focused: false,
    })).toBeNull();
    now += 100;
    recorder.record({
      kind: "editor_unmount",
      composing: false,
      focused: true,
    });
    now += 100;
    expect(recorder.record({
      kind: "editor_mount",
      composing: false,
      focused: false,
    })).toBe("editor_remounted");

    for (let index = 0; index < 220; index += 1) {
      now += 1;
      recorder.record({
        kind: "value_change",
        action: "insert_text",
        composing: false,
        focused: true,
      });
    }
    expect(recorder.snapshot()).toHaveLength(180);
  });

  it("detects a text-input jump emitted only with a value change", () => {
    let now = 1_000;
    const recorder = new CaretTraceRecorder("document", () => now);
    recorder.record({
      kind: "selection_change",
      selection: tableSelection(2, 2),
      composing: false,
      focused: true,
    });
    now += 20;
    recorder.record({
      kind: "beforeinput",
      inputType: "insertText",
      selection: tableSelection(2, 2),
      composing: false,
      focused: true,
    });
    now += 20;
    expect(recorder.record({
      kind: "value_change",
      operationTypes: ["insert_text"],
      selection: {
        kind: "text",
        collapsed: true,
        anchor: { path: [0, 0], offset: 0 },
        focus: { path: [0, 0], offset: 0 },
        selectedCellCount: 0,
      },
      composing: false,
      focused: true,
    })).toBe("table_selection_escaped");
  });

  it("classifies printable and navigation keys without recording their text", () => {
    expect(diagnosticKey({ key: "가", altKey: false, ctrlKey: false, metaKey: false }))
      .toBe("text");
    expect(diagnosticKey({ key: "ArrowLeft", altKey: false, ctrlKey: false, metaKey: false }))
      .toBe("arrow_left");
    expect(diagnosticKey({ key: "s", altKey: false, ctrlKey: true, metaKey: false }))
      .toBe("shortcut");
  });
});
