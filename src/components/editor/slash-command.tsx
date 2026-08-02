"use client";

import * as React from "react";
import {
  Combobox,
  ComboboxItem,
  ComboboxPopover,
  ComboboxProvider,
  Portal,
  useComboboxContext,
  useComboboxStore,
} from "@ariakit/react";
import { useComboboxInput, useHTMLInputCursorState } from "@platejs/combobox/react";
import { insertTable } from "@platejs/table";
import { insertCodeBlock } from "@platejs/code-block";
import {
  CheckSquare2,
  FileCode2,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  List,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Sparkles,
  Table2,
  type LucideIcon,
} from "lucide-react";
import {
  KEYS,
  type PointRef,
  type TComboboxInputElement,
  type TElement,
} from "platejs";
import {
  PlateElement,
  type PlateEditor,
  type PlateElementProps,
} from "platejs/react";
import { useI18n } from "@/lib/i18n/client";
import { localeTag, type AppLocale } from "@/lib/i18n/locales";
import styles from "./slash-command.module.css";

type SlashCommand = {
  description: string;
  icon: LucideIcon;
  keywords: string[];
  label: string;
  value: string;
};

function slashCommands(locale: AppLocale): SlashCommand[] {
  const copy = {
    en: {
      paragraph: ["Text", "Change to a regular paragraph.", "text paragraph"],
      h1: ["Heading 1", "The largest section heading.", "h1 heading title"],
      h2: ["Heading 2", "A medium section heading.", "h2 heading subtitle"],
      h3: ["Heading 3", "A small section heading.", "h3 heading"],
      h4: ["Heading 4", "A fourth-level section heading.", "h4 heading"],
      h5: ["Heading 5", "A fifth-level section heading.", "h5 heading"],
      h6: ["Heading 6", "A sixth-level section heading.", "h6 heading"],
      bullet: ["Bulleted list", "Start an unordered list.", "bullet list ul"],
      number: ["Numbered list", "Start an ordered list.", "number list ol"],
      todo: ["To-do list", "Create a checkable item.", "todo task check"],
      quote: ["Quote", "Emphasize content as a quotation.", "quote blockquote"],
      callout: ["Callout", "Place important content in a separate box.", "callout note"],
      divider: ["Divider", "Insert a divider between content.", "divider line hr"],
      code: ["Code block", "Enter multiline code in a monospace font.", "code pre"],
      table: ["Table", "Insert a 3 × 3 table.", "table grid"],
    },
    ko: {
      paragraph: ["본문", "일반 문단으로 바꿉니다.", "text paragraph 텍스트"],
      h1: ["제목 1", "가장 큰 섹션 제목입니다.", "h1 heading title"],
      h2: ["제목 2", "중간 크기의 섹션 제목입니다.", "h2 heading subtitle"],
      h3: ["제목 3", "작은 섹션 제목입니다.", "h3 heading"],
      h4: ["제목 4", "4단계 섹션 제목입니다.", "h4 heading"],
      h5: ["제목 5", "5단계 섹션 제목입니다.", "h5 heading"],
      h6: ["제목 6", "6단계 섹션 제목입니다.", "h6 heading"],
      bullet: ["글머리 목록", "순서 없는 목록을 시작합니다.", "bullet list ul 목록"],
      number: ["번호 목록", "순서가 있는 목록을 시작합니다.", "number list ol 목록"],
      todo: ["할 일 목록", "체크할 수 있는 항목을 만듭니다.", "todo task check 체크"],
      quote: ["인용", "인용문으로 강조합니다.", "quote blockquote"],
      callout: ["콜아웃", "중요한 내용을 별도 상자로 표시합니다.", "callout note 안내"],
      divider: ["구분선", "내용 사이에 구분선을 넣습니다.", "divider line hr"],
      code: ["코드 블록", "여러 줄 코드를 고정폭 글꼴로 입력합니다.", "code pre 코드"],
      table: ["표", "3 × 3 표를 넣습니다.", "table grid 테이블"],
    },
    ja: {
      paragraph: ["本文", "通常の段落に変更します。", "text paragraph テキスト"],
      h1: ["見出し1", "最も大きいセクション見出しです。", "h1 heading title 見出し"],
      h2: ["見出し2", "中くらいのセクション見出しです。", "h2 heading subtitle 見出し"],
      h3: ["見出し3", "小さいセクション見出しです。", "h3 heading 見出し"],
      h4: ["見出し4", "第4階層のセクション見出しです。", "h4 heading 見出し"],
      h5: ["見出し5", "第5階層のセクション見出しです。", "h5 heading 見出し"],
      h6: ["見出し6", "第6階層のセクション見出しです。", "h6 heading 見出し"],
      bullet: ["箇条書き", "順序なしリストを開始します。", "bullet list ul 箇条書き"],
      number: ["番号付きリスト", "順序付きリストを開始します。", "number list ol 番号"],
      todo: ["To-doリスト", "チェック可能な項目を作成します。", "todo task check チェック"],
      quote: ["引用", "引用として強調します。", "quote blockquote 引用"],
      callout: ["コールアウト", "重要な内容を別のボックスに表示します。", "callout note 案内"],
      divider: ["区切り線", "内容の間に区切り線を入れます。", "divider line hr"],
      code: ["コードブロック", "複数行コードを等幅フォントで入力します。", "code pre コード"],
      table: ["表", "3 × 3の表を挿入します。", "table grid テーブル"],
    },
  }[locale];
  const command = (
    value: string,
    [label, description, keywords]: string[],
    icon: LucideIcon,
  ): SlashCommand => ({ value, label, description, keywords: keywords.split(" "), icon });
  return [
    command(KEYS.p, copy.paragraph, Pilcrow),
    command(KEYS.h1, copy.h1, Heading1),
    command(KEYS.h2, copy.h2, Heading2),
    command(KEYS.h3, copy.h3, Heading3),
    command(KEYS.h4, copy.h4, Heading4),
    command(KEYS.h5, copy.h5, Heading5),
    command(KEYS.h6, copy.h6, Heading6),
    command(KEYS.ul, copy.bullet, List),
    command(KEYS.ol, copy.number, ListOrdered),
    command(KEYS.listTodo, copy.todo, CheckSquare2),
    command(KEYS.blockquote, copy.quote, Quote),
    command(KEYS.callout, copy.callout, Sparkles),
    command(KEYS.hr, copy.divider, Minus),
    command(KEYS.codeBlock, copy.code, FileCode2),
    command(KEYS.table, copy.table, Table2),
  ];
}

const listTypes = new Set<string>([KEYS.ul, KEYS.ol, KEYS.listTodo]);

function selectBlockStart(editor: PlateEditor, path: number[]) {
  const start = editor.api.start(path);
  if (start) editor.tf.select(start);
}
function setCurrentBlock(editor: PlateEditor, type: string) {
  const entry = editor.api.block<TElement>();
  if (!entry) return;

  const [node, path] = entry;
  editor.tf.withoutNormalizing(() => {
    editor.tf.unsetNodes([KEYS.listType, "checked", "indent"], { at: path });
    editor.tf.setNodes({ type }, { at: path });
  });

  if (node.type !== KEYS.hr) selectBlockStart(editor, path);
}

function setCurrentList(editor: PlateEditor, listStyleType: string) {
  const entry = editor.api.block<TElement>();
  if (!entry) return;

  const [, path] = entry;
  editor.tf.withoutNormalizing(() => {
    editor.tf.unsetNodes(["checked"], { at: path });
    editor.tf.setNodes({
      type: KEYS.p,
      indent: 1,
      listStyleType,
      ...(listStyleType === KEYS.listTodo ? { checked: false } : {}),
    }, { at: path });
  });
  selectBlockStart(editor, path);
}

function insertDivider(editor: PlateEditor) {
  const entry = editor.api.block<TElement>();
  if (!entry) return;

  const [, path] = entry;
  editor.tf.withoutNormalizing(() => {
    editor.tf.unsetNodes([KEYS.listType, "checked", "indent"], { at: path });
    editor.tf.setNodes({ type: KEYS.hr }, { at: path });
    editor.tf.insertNodes(editor.api.create.block({ type: KEYS.p }), {
      at: [path[0] + 1],
      select: true,
    });
  });
}

function insertCommandTable(editor: PlateEditor) {
  const entry = editor.api.block<TElement>();
  const removePath = entry && editor.api.isEmpty(entry[0]) ? [...entry[1]] : null;

  editor.tf.withoutNormalizing(() => {
    insertTable(
      editor,
      { colCount: 3, header: true, rowCount: 3 },
      { select: true },
    );
    if (removePath && editor.api.node(removePath)) {
      editor.tf.removeNodes({ at: removePath });
    }
  });
}

function runSlashCommand(editor: PlateEditor, value: string) {
  if (listTypes.has(value)) {
    setCurrentList(editor, value);
  } else if (value === KEYS.table) {
    insertCommandTable(editor);
  } else if (value === KEYS.hr) {
    insertDivider(editor);
  } else if (value === KEYS.codeBlock) {
    insertCodeBlock(editor);
  } else {
    setCurrentBlock(editor, value);
  }
  editor.tf.focus();
}

function SlashItems({
  commands,
  emptyLabel,
  onSelect,
}: {
  commands: SlashCommand[];
  emptyLabel: string;
  onSelect: (value: string) => void;
}) {
  const store = useComboboxContext();

  React.useEffect(() => {
    if (store && !store.getState().activeId) store.setActiveId(store.first());
  }, [commands, store]);

  if (commands.length === 0) {
    return <div className={styles.empty}>{emptyLabel}</div>;
  }

  return commands.map((command) => {
    const Icon = command.icon;
    return (
      <ComboboxItem
        className={styles.item}
        key={command.value}
        value={command.value}
        onMouseDown={(event) => {
          event.preventDefault();
          onSelect(command.value);
        }}
        onClick={() => onSelect(command.value)}
      >
        <span className={styles.itemIcon}><Icon aria-hidden="true" size={17} /></span>
        <span className={styles.itemCopy}>
          <strong>{command.label}</strong>
          <small>{command.description}</small>
        </span>
      </ComboboxItem>
    );
  });
}

export function NyxdocSlashInputElement(
  props: PlateElementProps<TComboboxInputElement>,
) {
  const { locale } = useI18n();
  const copy = {
    en: { search: "Search slash commands", add: "Add block", empty: "No matching commands." },
    ko: { search: "슬래시 명령 검색", add: "블록 추가", empty: "일치하는 명령이 없습니다." },
    ja: { search: "スラッシュコマンドを検索", add: "ブロックを追加", empty: "一致するコマンドがありません。" },
  }[locale];
  const commands = React.useMemo(() => slashCommands(locale), [locale]);
  const { editor, element } = props;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const cursorState = useHTMLInputCursorState(inputRef);
  const insertPointRef = React.useRef<PointRef | null>(null);

  React.useEffect(() => {
    insertPointRef.current?.unref();
    insertPointRef.current = null;

    const path = editor.api.findPath(element);
    if (!path) return;
    const point = editor.api.before(path);
    if (!point) return;

    const pointRef = editor.api.pointRef(point);
    insertPointRef.current = pointRef;
    return () => {
      if (insertPointRef.current === pointRef) insertPointRef.current = null;
      pointRef.unref();
    };
  }, [editor, element]);

  const { props: inputProps, removeInput } = useComboboxInput({
    autoFocus: true,
    cancelInputOnBlur: true,
    cursorState,
    ref: inputRef,
    onCancelInput: (cause) => {
      if (cause !== "backspace") {
        const value = inputRef.current?.value ?? "";
        editor.tf.insertText(`/${value}`, {
          at: insertPointRef.current?.current ?? undefined,
        });
      }
      if (cause === "arrowLeft" || cause === "arrowRight") {
        editor.tf.move({ distance: 1, reverse: cause === "arrowLeft" });
      }
    },
  });

  const store = useComboboxStore();
  const search = store.useState("value");
  const normalizedSearch = search.trim().toLocaleLowerCase(localeTag(locale));
  const filteredCommands = React.useMemo(() => {
    if (!normalizedSearch) return commands;
    return commands.filter((command) => (
      [command.label, command.value, ...command.keywords]
        .join(" ")
        .toLocaleLowerCase(localeTag(locale))
        .includes(normalizedSearch)
    ));
  }, [commands, locale, normalizedSearch]);

  const handleSelect = React.useCallback((value: string) => {
    removeInput(true);
    runSlashCommand(editor, value);
  }, [editor, removeInput]);

  return (
    <PlateElement {...props} as="span">
      <span className={styles.inline} contentEditable={false}>
        <ComboboxProvider open store={store}>
          <span className={styles.inputShell}>
            <span aria-hidden="true">/</span>
            <span className={styles.inputSizer} aria-hidden="true">{search || "\u200B"}</span>
            <Combobox
              {...inputProps}
              aria-label={copy.search}
              autoSelect
              className={styles.input}
              ref={inputRef}
              value={search}
            />
          </span>

          <Portal>
            <ComboboxPopover className={styles.menu} gutter={7}>
              <div className={styles.menuHeader}>{copy.add}</div>
              <SlashItems
                commands={filteredCommands}
                emptyLabel={copy.empty}
                onSelect={handleSelect}
              />
            </ComboboxPopover>
          </Portal>
        </ComboboxProvider>
      </span>
      {props.children}
    </PlateElement>
  );
}
