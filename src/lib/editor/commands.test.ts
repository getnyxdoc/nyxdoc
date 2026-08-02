import { describe, expect, it } from "vitest";
import {
  BaseParagraphPlugin,
  createSlateEditor,
  type TElement,
  type TTableCellElement,
  type TTableElement,
  type TTableRowElement,
  type Value,
} from "platejs";
import { BaseLinkPlugin, unwrapLink, upsertLink } from "@platejs/link";
import {
  BaseTableCellHeaderPlugin,
  BaseTableCellPlugin,
  BaseTablePlugin,
  BaseTableRowPlugin,
  deleteColumn,
  deleteRow,
  deleteTable,
} from "@platejs/table";

const tableDocument: Value = [
  { id: "before", type: "p", children: [{ text: "표 앞" }] },
  {
    id: "table",
    type: "table",
    colSizes: [180, 220],
    children: [
      {
        id: "row-1",
        type: "tr",
        children: [
          {
            id: "cell-1-1",
            type: "th",
            children: [{ id: "cell-p-1-1", type: "p", children: [{ text: "항목" }] }],
          },
          {
            id: "cell-1-2",
            type: "th",
            children: [{ id: "cell-p-1-2", type: "p", children: [{ text: "담당" }] }],
          },
        ],
      },
      {
        id: "row-2",
        type: "tr",
        children: [
          {
            id: "cell-2-1",
            type: "td",
            children: [{ id: "cell-p-2-1", type: "p", children: [{ text: "문서" }] }],
          },
          {
            id: "cell-2-2",
            type: "td",
            children: [{ id: "cell-p-2-2", type: "p", children: [{ text: "Codex" }] }],
          },
        ],
      },
    ],
  },
  { id: "after", type: "p", children: [{ text: "표 뒤" }] },
];

function createEditor(value: Value = tableDocument) {
  let generatedId = 0;
  return createSlateEditor({
    plugins: [
      BaseParagraphPlugin,
      BaseLinkPlugin,
      BaseTablePlugin,
      BaseTableRowPlugin,
      BaseTableCellPlugin,
      BaseTableCellHeaderPlugin,
    ],
    value: structuredClone(value),
    nodeId: { idCreator: () => `generated-${++generatedId}` },
  });
}

function selectSecondDataCell(editor: ReturnType<typeof createEditor>) {
  editor.tf.select({ path: [1, 1, 1, 0, 0], offset: 0 });
}

function currentTable(editor: ReturnType<typeof createEditor>) {
  return editor.children.find((node) => (node as TElement).type === "table") as
    | TTableElement
    | undefined;
}

describe("editor table commands", () => {
  it("deletes the selected row and moves the caret into a surviving cell", () => {
    const editor = createEditor();
    selectSecondDataCell(editor);

    deleteRow(editor);

    const table = currentTable(editor);
    expect(table?.children).toHaveLength(1);
    expect(table?.children[0].id).toBe("row-1");
    expect(editor.selection?.anchor.path.slice(0, 2)).toEqual([1, 0]);
  });

  it("deletes the selected column from every row without losing the other cells", () => {
    const editor = createEditor();
    selectSecondDataCell(editor);

    deleteColumn(editor);

    const table = currentTable(editor);
    expect(table?.children.map((row) =>
      (row as TTableRowElement).children.map((cell) => (cell as TTableCellElement).id),
    )).toEqual([
      ["cell-1-1"],
      ["cell-2-1"],
    ]);
  });

  it("deletes a whole table, keeps the following paragraph, and supports undo/redo", () => {
    const editor = createEditor();
    selectSecondDataCell(editor);

    deleteTable(editor);

    expect(currentTable(editor)).toBeUndefined();
    expect((editor.children[1] as TElement).id).toBe("after");
    expect(editor.selection?.anchor.path).toEqual([1, 0]);

    editor.tf.undo();
    expect(currentTable(editor)?.id).toBe("table");

    editor.tf.redo();
    expect(currentTable(editor)).toBeUndefined();
  });

  it("removes a one-cell table when its only row or column is deleted", () => {
    const oneCellDocument: Value = [
      {
        id: "only-table",
        type: "table",
        children: [
          {
            id: "only-row",
            type: "tr",
            children: [
              {
                id: "only-cell",
                type: "td",
                children: [{ id: "only-p", type: "p", children: [{ text: "내용" }] }],
              },
            ],
          },
        ],
      },
      { id: "trailing", type: "p", children: [{ text: "" }] },
    ];

    for (const command of [deleteRow, deleteColumn]) {
      const editor = createEditor(oneCellDocument);
      editor.tf.select({ path: [0, 0, 0, 0, 0], offset: 0 });

      command(editor);

      expect(currentTable(editor)).toBeUndefined();
      expect((editor.children[0] as TElement).id).toBe("trailing");
    }
  });
});

describe("editor link commands", () => {
  it("wraps selected text in a valid link and unwraps it without changing text", () => {
    const editor = createEditor([
      { id: "paragraph", type: "p", children: [{ text: "Nyxdoc 안내" }] },
    ]);
    editor.tf.select({
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 6 },
    });

    expect(upsertLink(editor, { url: "https://nyxdoc.com/guide" })).toBe(true);
    const paragraph = editor.children[0] as TElement;
    const link = paragraph.children.find((child) => (child as TElement).type === "a") as TElement & {
      url: string;
    };
    expect(link.url).toBe("https://nyxdoc.com/guide");
    expect(link.children).toEqual([{ text: "Nyxdoc" }]);

    unwrapLink(editor);
    expect((editor.children[0] as TElement).children).toEqual([{ text: "Nyxdoc 안내" }]);
  });
});
