import type {
  CaretIncidentReason,
  CaretSelectionSnapshot,
  CaretTraceEvent,
} from "@/lib/editor/diagnostics";

const MAX_TRACE_EVENTS = 180;
const NAVIGATION_KEYS = new Set([
  "arrow_down",
  "arrow_left",
  "arrow_right",
  "arrow_up",
  "end",
  "home",
  "page_down",
  "page_up",
  "tab",
]);

type TraceInput = Omit<CaretTraceEvent, "elapsedMs" | "sequence">;

type RecentIntent = {
  elapsedMs: number;
  inputType?: string;
  key?: CaretTraceEvent["key"];
  kind: "beforeinput" | "keydown" | "pointer";
};

function sameTableCell(
  left: CaretSelectionSnapshot["table"],
  right: CaretSelectionSnapshot["table"],
) {
  return Boolean(
    left
    && right
    && left.blockIndex === right.blockIndex
    && left.rowIndex === right.rowIndex
    && left.columnIndex === right.columnIndex,
  );
}

function topLevelIndex(selection: CaretSelectionSnapshot | undefined) {
  return selection?.anchor?.path[0];
}

function isDocumentStart(selection: CaretSelectionSnapshot | undefined) {
  return Boolean(
    selection?.anchor
    && selection.anchor.path[0] === 0
    && selection.anchor.offset === 0,
  );
}

function isTextMutation(intent: RecentIntent | null, elapsedMs: number) {
  if (!intent || intent.kind !== "beforeinput") return false;
  if (elapsedMs - intent.elapsedMs > 1_200) return false;
  return Boolean(
    intent.inputType?.startsWith("insert")
    || intent.inputType?.startsWith("delete"),
  );
}

function intentionalSelectionMovement(intent: RecentIntent | null, elapsedMs: number) {
  if (!intent || elapsedMs - intent.elapsedMs > 800) return false;
  if (intent.kind === "pointer") return true;
  return intent.kind === "keydown" && Boolean(intent.key && NAVIGATION_KEYS.has(intent.key));
}

export function detectCaretAnomaly(input: {
  previous: CaretSelectionSnapshot | undefined;
  current: CaretSelectionSnapshot | undefined;
  intent: RecentIntent | null;
  elapsedMs: number;
  composing: boolean;
}): CaretIncidentReason | null {
  const { previous, current, intent, elapsedMs, composing } = input;
  if (!previous || !current || composing) return null;
  if (previous.kind === "none" || current.kind === "none") return null;
  if (intentionalSelectionMovement(intent, elapsedMs)) return null;
  if (!isTextMutation(intent, elapsedMs)) return null;

  if (previous.table && !current.table) return "table_selection_escaped";
  if (previous.table && current.table && !sameTableCell(previous.table, current.table)) {
    return "table_cell_changed";
  }
  if (!isDocumentStart(previous) && isDocumentStart(current)) {
    return "jumped_to_document_start";
  }

  const previousBlock = topLevelIndex(previous);
  const currentBlock = topLevelIndex(current);
  if (
    previousBlock !== undefined
    && currentBlock !== undefined
    && Math.abs(previousBlock - currentBlock) > 1
  ) {
    return "unexpected_block_jump";
  }
  return null;
}

export class CaretTraceRecorder {
  private readonly startedAt: number;
  private sequence = 0;
  private events: CaretTraceEvent[] = [];
  private lastSelection: CaretSelectionSnapshot | undefined;
  private lastIntent: RecentIntent | null = null;
  private composing = false;
  private lastUnmount: { elapsedMs: number; focused: boolean } | null = null;
  private mountCounter = 0;

  constructor(
    readonly documentId: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.startedAt = now();
  }

  get mountCount() {
    return this.mountCounter;
  }

  record(input: TraceInput): CaretIncidentReason | null {
    const elapsedMs = Math.max(0, Math.round(this.now() - this.startedAt));
    const event: CaretTraceEvent = {
      ...input,
      sequence: this.sequence,
      elapsedMs,
    };
    this.sequence += 1;
    this.events.push(event);
    if (this.events.length > MAX_TRACE_EVENTS) {
      this.events.splice(0, this.events.length - MAX_TRACE_EVENTS);
    }

    if (event.kind === "composition_start") this.composing = true;
    if (event.kind === "composition_end") this.composing = false;
    if (event.kind === "pointer_down" || event.kind === "pointer_up") {
      this.lastIntent = { elapsedMs, kind: "pointer" };
    } else if (event.kind === "keydown") {
      this.lastIntent = { elapsedMs, key: event.key, kind: "keydown" };
    } else if (event.kind === "beforeinput") {
      this.lastIntent = { elapsedMs, inputType: event.inputType, kind: "beforeinput" };
    }

    if (event.kind === "editor_unmount") {
      this.lastUnmount = { elapsedMs, focused: event.focused };
      return null;
    }
    if (event.kind === "editor_mount") {
      this.mountCounter += 1;
      const unexpectedRemount = this.mountCounter > 1
        && this.lastUnmount?.focused
        && elapsedMs - this.lastUnmount.elapsedMs < 2_000;
      this.lastUnmount = null;
      return unexpectedRemount ? "editor_remounted" : null;
    }
    if (event.kind !== "selection_change" && event.kind !== "value_change") return null;
    if (
      event.kind === "value_change"
      && event.operationTypes?.includes("insert_node")
      && event.operationTypes.includes("remove_node")
    ) {
      // Agent-side whole-document updates temporarily reset Slate's selection.
      // The editor restores that selection from stable node IDs separately.
      return null;
    }

    const reason = detectCaretAnomaly({
      previous: this.lastSelection,
      current: event.selection,
      intent: this.lastIntent,
      elapsedMs,
      composing: this.composing,
    });
    this.lastSelection = event.selection;
    return reason;
  }

  reportEvent(trigger: "manual" | "automatic", reason: CaretIncidentReason) {
    this.record({
      kind: trigger === "manual" ? "manual_report" : "automatic_report",
      action: reason,
      composing: this.composing,
      focused: true,
      selection: this.lastSelection,
    });
  }

  snapshot() {
    return structuredClone(this.events);
  }
}

const recorderRegistry = new Map<string, CaretTraceRecorder>();

export function getCaretTraceRecorder(documentId: string) {
  const existing = recorderRegistry.get(documentId);
  if (existing) return existing;
  const recorder = new CaretTraceRecorder(documentId);
  recorderRegistry.set(documentId, recorder);
  if (recorderRegistry.size > 12) {
    const oldest = recorderRegistry.keys().next().value as string | undefined;
    if (oldest) recorderRegistry.delete(oldest);
  }
  return recorder;
}

export function diagnosticKey(event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">) {
  if (event.ctrlKey || event.metaKey || event.altKey) return "shortcut" as const;
  return ({
    ArrowDown: "arrow_down",
    ArrowLeft: "arrow_left",
    ArrowRight: "arrow_right",
    ArrowUp: "arrow_up",
    Backspace: "backspace",
    Delete: "delete",
    End: "end",
    Enter: "enter",
    Home: "home",
    PageDown: "page_down",
    PageUp: "page_up",
    Tab: "tab",
  } as const)[event.key] ?? (event.key.length === 1 ? "text" : "other");
}
