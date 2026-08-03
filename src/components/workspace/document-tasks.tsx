"use client";

import Link from "next/link";
import Image from "next/image";
import {
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  CircleDashed,
  FileText,
  ImagePlus,
  ListTodo,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type ClipboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { UserAvatar } from "@/components/profile/user-avatar";
import type { WorkspaceAgentSummary } from "@/lib/collaboration/types";
import type { DocumentSummary } from "@/lib/documents/types";
import type {
  DocumentTask,
  DocumentTaskAttachment,
  DocumentTaskAttachmentField,
  DocumentTaskEvent,
  DocumentTaskPriority,
  DocumentTaskStatus,
} from "@/lib/tasks/types";
import { uploadMediaFile } from "@/lib/media/client";
import { useI18n } from "@/lib/i18n/client";
import { defineUiCopy, formatCopy } from "@/lib/i18n/copy";
import { localeTag, type AppLocale } from "@/lib/i18n/locales";
import {
  orderedActiveTaskAgents,
  taskAgentAccessLabel,
} from "./document-task-options";
import { DocumentTargetPicker } from "./document-target-picker";
import styles from "./workspace.module.css";

type Props = {
  workspaceId: string;
  activeDocumentId: string;
  initialTasks: DocumentTask[];
  agents: WorkspaceAgentSummary[];
  documents: DocumentSummary[];
  canCreate: boolean;
  canUpdate: boolean;
  canManage: boolean;
};

type ApiBody = {
  error?: string;
  task?: DocumentTask;
  tasks?: DocumentTask[];
  events?: DocumentTaskEvent[];
};

type TaskDraft = {
  title: string;
  description: string;
  acceptanceCriteria: string;
  attachments: DocumentTaskAttachment[];
  priority: DocumentTaskPriority;
  targetDocumentId: string;
  assignedAgentId: string;
  requiresReview: boolean;
  status: DocumentTaskStatus;
  progress: number;
  blocker: string;
  resultSummary: string;
};

type TaskFilter = "todo" | "active" | "review" | "completed" | "all";
type TaskAttachmentUpdate =
  | DocumentTaskAttachment[]
  | ((current: DocumentTaskAttachment[]) => DocumentTaskAttachment[]);

const TASK_COPY = defineUiCopy({
  en: {
    statusReady: "To-do",
    statusInProgress: "In progress",
    statusBlocked: "Blocked",
    statusReview: "Needs review",
    statusCompleted: "Completed",
    statusCancelled: "Cancelled",
    priorityLow: "Low",
    priorityNormal: "Normal",
    priorityHigh: "High",
    priorityUrgent: "Urgent",
    eventCreated: "Task created",
    eventUpdated: "Task updated",
    eventClaimed: "Task started",
    eventProgress: "Progress",
    eventBlocked: "Blocker reported",
    eventSubmitted: "Agent result submitted",
    eventCompleted: "Task completed",
    eventReopened: "Reopened",
    eventCancelled: "Task cancelled",
    wholeWorkspace: "Entire workspace",
    targetDocument: "Target document",
    tooManyImages: "An Agent To-do can contain up to 20 images.",
    uploadFailed: "Could not upload the screenshot.",
    description: "Description",
    acceptanceCriteria: "Completion criteria",
    addImage: "Add an image to {field}",
    uploading: "Uploading…",
    image: "Image",
    pasteHint: "You can also paste a screenshot from the clipboard into this field.",
    attachment: "Attached image",
    viewLarge: "View {name} at full size",
    todoAttachment: "Agent To-do attachment",
    pastedImage: "Pasted image",
    removeAttachment: "Remove attached image",
    loadFailed: "Could not load Agent To-dos.",
    createFailed: "Could not create the Agent To-do.",
    saveFailed: "Could not save the Agent To-do.",
    todoCount: "{count} Agent To-dos",
    quickAdd: "Quickly add an Agent To-do",
    close: "Close Agent To-do",
    dialogDescription: "An external agent continues a document request left by a person and returns the result.",
    all: "All",
    newTodo: "New Agent To-do",
    noTasks: "There are no To-dos in this state.",
    unassigned: "Unassigned",
    unassignedClaim: "Unassigned · an agent can claim it",
    createIntro: "Start with a single line. You can add details and completion criteria later.",
    whatToDo: "What should be done?",
    titlePlaceholder: "Example: Add the missing deployment steps to the operations document",
    chooseTarget: "Choose target document",
    assignee: "Assigned agent",
    priority: "Priority",
    reviewAfterSubmit: "A person reviews the result after the agent submits it.",
    optional: "Optional",
    descriptionPlaceholder: "Add background information or directions that must be followed.",
    acceptancePlaceholder: "Describe what the completed result should look like.",
    cancel: "Cancel",
    imageUploading: "Uploading images…",
    adding: "Adding…",
    addTask: "Add task",
    version: "Version {version}",
    taskTitle: "Task title",
    status: "Status",
    progress: "Progress",
    requireReview: "Require human review after result submission",
    blocker: "Blocker",
    agentResult: "Agent result",
    resultDocument: "Result document",
    revision: "Revision {number}",
    history: "Task history",
    noHistory: "No history yet.",
    markReviewed: "Mark reviewed",
    reopen: "Reopen",
    saving: "Saving…",
    saveChanges: "Save changes",
    readOnly: "You can only read Agent To-dos in this workspace.",
    chooseTask: "Choose an Agent To-do to process.",
    recordContinuity: "The person’s request and the agent’s result remain in one record.",
  },
  ko: {
    statusReady: "To-do",
    statusInProgress: "진행 중",
    statusBlocked: "막힘",
    statusReview: "확인 필요",
    statusCompleted: "완료",
    statusCancelled: "취소",
    priorityLow: "낮음",
    priorityNormal: "보통",
    priorityHigh: "높음",
    priorityUrgent: "긴급",
    eventCreated: "작업 생성",
    eventUpdated: "작업 수정",
    eventClaimed: "작업 시작",
    eventProgress: "진행 상황",
    eventBlocked: "막힘 보고",
    eventSubmitted: "에이전트 결과 제출",
    eventCompleted: "작업 완료",
    eventReopened: "다시 열림",
    eventCancelled: "작업 취소",
    wholeWorkspace: "워크스페이스 전체",
    targetDocument: "대상 문서",
    tooManyImages: "Agent To-do에는 이미지를 최대 20개까지 첨부할 수 있습니다.",
    uploadFailed: "스크린샷을 업로드하지 못했습니다.",
    description: "설명",
    acceptanceCriteria: "완료 조건",
    addImage: "{field} 이미지 추가",
    uploading: "업로드 중…",
    image: "이미지",
    pasteHint: "클립보드의 스크린샷을 이 입력란에 붙여넣어도 됩니다.",
    attachment: "첨부 이미지",
    viewLarge: "{name} 크게 보기",
    todoAttachment: "Agent To-do 첨부 이미지",
    pastedImage: "붙여넣은 이미지",
    removeAttachment: "첨부 이미지 제거",
    loadFailed: "Agent To-do를 불러오지 못했습니다.",
    createFailed: "Agent To-do를 만들지 못했습니다.",
    saveFailed: "Agent To-do를 저장하지 못했습니다.",
    todoCount: "Agent To-do {count}개",
    quickAdd: "Agent To-do 빠르게 추가",
    close: "Agent To-do 닫기",
    dialogDescription: "사람이 남긴 문서 요청을 외부 에이전트가 이어서 수행하고 결과를 돌려줍니다.",
    all: "전체",
    newTodo: "새 Agent To-do",
    noTasks: "이 상태의 To-do가 없습니다.",
    unassigned: "담당 미지정",
    unassignedClaim: "담당 미지정 · 에이전트가 가져가기",
    createIntro: "먼저 한 줄만 남겨도 됩니다. 필요한 설명과 완료 조건은 나중에 보완할 수 있어요.",
    whatToDo: "무엇을 해두면 좋을까요?",
    titlePlaceholder: "예: 운영 문서의 빠진 배포 절차를 보강해줘",
    chooseTarget: "대상 문서 선택",
    assignee: "담당 에이전트",
    priority: "우선순위",
    reviewAfterSubmit: "에이전트가 결과를 제출하면 사람이 확인합니다.",
    optional: "선택",
    descriptionPlaceholder: "배경이나 지켜야 할 방향을 적어주세요.",
    acceptancePlaceholder: "어떤 상태가 되면 완료인지 적어주세요.",
    cancel: "취소",
    imageUploading: "이미지 업로드 중…",
    adding: "추가 중…",
    addTask: "작업 추가",
    version: "버전 {version}",
    taskTitle: "작업 제목",
    status: "상태",
    progress: "진행률",
    requireReview: "결과 제출 후 사람 확인 필요",
    blocker: "막힌 이유",
    agentResult: "에이전트 작업 결과",
    resultDocument: "결과 문서",
    revision: "리비전 {number}",
    history: "작업 이력",
    noHistory: "아직 기록이 없습니다.",
    markReviewed: "확인 완료",
    reopen: "다시 열기",
    saving: "저장 중…",
    saveChanges: "변경 저장",
    readOnly: "이 워크스페이스에서는 Agent To-do를 읽을 수만 있습니다.",
    chooseTask: "처리할 Agent To-do를 선택하세요.",
    recordContinuity: "사람의 요청과 에이전트의 작업 결과가 한 기록으로 이어집니다.",
  },
  ja: {
    statusReady: "To-do",
    statusInProgress: "進行中",
    statusBlocked: "ブロック中",
    statusReview: "確認が必要",
    statusCompleted: "完了",
    statusCancelled: "キャンセル済み",
    priorityLow: "低",
    priorityNormal: "通常",
    priorityHigh: "高",
    priorityUrgent: "緊急",
    eventCreated: "タスク作成",
    eventUpdated: "タスク更新",
    eventClaimed: "タスク開始",
    eventProgress: "進捗",
    eventBlocked: "ブロッカー報告",
    eventSubmitted: "エージェントが結果を提出",
    eventCompleted: "タスク完了",
    eventReopened: "再開",
    eventCancelled: "タスクをキャンセル",
    wholeWorkspace: "ワークスペース全体",
    targetDocument: "対象文書",
    tooManyImages: "Agent To-doには画像を20件まで添付できます。",
    uploadFailed: "スクリーンショットをアップロードできませんでした。",
    description: "説明",
    acceptanceCriteria: "完了条件",
    addImage: "{field}に画像を追加",
    uploading: "アップロード中…",
    image: "画像",
    pasteHint: "クリップボードのスクリーンショットをこの欄に貼り付けることもできます。",
    attachment: "添付画像",
    viewLarge: "{name}を大きく表示",
    todoAttachment: "Agent To-doの添付画像",
    pastedImage: "貼り付けた画像",
    removeAttachment: "添付画像を削除",
    loadFailed: "Agent To-doを読み込めませんでした。",
    createFailed: "Agent To-doを作成できませんでした。",
    saveFailed: "Agent To-doを保存できませんでした。",
    todoCount: "Agent To-do {count}件",
    quickAdd: "Agent To-doをすばやく追加",
    close: "Agent To-doを閉じる",
    dialogDescription: "人が残した文書リクエストを外部エージェントが引き継ぎ、結果を返します。",
    all: "すべて",
    newTodo: "新しいAgent To-do",
    noTasks: "この状態のTo-doはありません。",
    unassigned: "担当未指定",
    unassignedClaim: "担当未指定 · エージェントが取得",
    createIntro: "まず1行だけでも構いません。説明と完了条件は後から追加できます。",
    whatToDo: "何をしておきますか？",
    titlePlaceholder: "例：運用文書に不足しているデプロイ手順を追加して",
    chooseTarget: "対象文書を選択",
    assignee: "担当エージェント",
    priority: "優先度",
    reviewAfterSubmit: "エージェントが結果を提出した後、人が確認します。",
    optional: "任意",
    descriptionPlaceholder: "背景や守るべき方針を入力してください。",
    acceptancePlaceholder: "どのような状態になれば完了かを入力してください。",
    cancel: "キャンセル",
    imageUploading: "画像をアップロード中…",
    adding: "追加中…",
    addTask: "タスクを追加",
    version: "バージョン {version}",
    taskTitle: "タスク名",
    status: "状態",
    progress: "進捗",
    requireReview: "結果提出後に人の確認が必要",
    blocker: "ブロックしている理由",
    agentResult: "エージェントの作業結果",
    resultDocument: "結果文書",
    revision: "リビジョン {number}",
    history: "タスク履歴",
    noHistory: "履歴はまだありません。",
    markReviewed: "確認完了",
    reopen: "再開",
    saving: "保存中…",
    saveChanges: "変更を保存",
    readOnly: "このワークスペースではAgent To-doを閲覧のみできます。",
    chooseTask: "処理するAgent To-doを選択してください。",
    recordContinuity: "人の依頼とエージェントの作業結果が1つの履歴につながります。",
  },
});

function statusLabels(locale: AppLocale): Record<DocumentTaskStatus, string> {
  const copy = TASK_COPY[locale];
  return {
    ready: copy.statusReady,
    in_progress: copy.statusInProgress,
    blocked: copy.statusBlocked,
    review: copy.statusReview,
    completed: copy.statusCompleted,
    cancelled: copy.statusCancelled,
  };
}

function priorityLabels(locale: AppLocale): Record<DocumentTaskPriority, string> {
  const copy = TASK_COPY[locale];
  return {
    low: copy.priorityLow,
    normal: copy.priorityNormal,
    high: copy.priorityHigh,
    urgent: copy.priorityUrgent,
  };
}

function eventLabels(
  locale: AppLocale,
): Record<DocumentTaskEvent["eventType"], string> {
  const copy = TASK_COPY[locale];
  return {
    created: copy.eventCreated,
    updated: copy.eventUpdated,
    claimed: copy.eventClaimed,
    progress: copy.eventProgress,
    blocked: copy.eventBlocked,
    submitted: copy.eventSubmitted,
    completed: copy.eventCompleted,
    reopened: copy.eventReopened,
    cancelled: copy.eventCancelled,
  };
}

function taskMatchesFilter(task: DocumentTask, filter: TaskFilter) {
  if (filter === "todo") return task.status === "ready";
  if (filter === "active") return ["in_progress", "blocked"].includes(task.status);
  if (filter === "review") return task.status === "review";
  if (filter === "completed") return task.status === "completed";
  return true;
}

function taskDraft(task: DocumentTask): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    attachments: task.attachments,
    priority: task.priority,
    targetDocumentId: task.targetDocumentId ?? "",
    assignedAgentId: task.assignedAgentId ?? "",
    requiresReview: task.requiresReview,
    status: task.status,
    progress: task.progress,
    blocker: task.blocker ?? "",
    resultSummary: task.resultSummary ?? "",
  };
}

function shortDate(value: string, locale: AppLocale) {
  return new Intl.DateTimeFormat(localeTag(locale), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function workspaceHref(workspaceId: string, documentId: string) {
  const query = new URLSearchParams({ workspace: workspaceId, document: documentId });
  return `/app?${query.toString()}`;
}

function taskPathLabel(
  task: DocumentTask,
  copy: (typeof TASK_COPY)[AppLocale],
) {
  if (!task.targetDocumentId) return copy.wholeWorkspace;
  return task.targetDocumentPath.map((item) => item.title).join(" / ")
    || task.targetDocumentTitle
    || copy.targetDocument;
}

function TaskTextWithImages({
  attachments,
  disabled,
  field,
  label,
  maxLength,
  onAttachmentsChange,
  onError,
  onTextChange,
  onUploadStateChange,
  placeholder,
  value,
  workspaceId,
}: {
  attachments: DocumentTaskAttachment[];
  disabled?: boolean;
  field: DocumentTaskAttachmentField;
  label: ReactNode;
  maxLength: number;
  onAttachmentsChange: (update: TaskAttachmentUpdate) => void;
  onError: (message: string) => void;
  onTextChange: (value: string) => void;
  onUploadStateChange: (uploading: boolean) => void;
  placeholder?: string;
  value: string;
  workspaceId: string;
}) {
  const { locale } = useI18n();
  const copy = TASK_COPY[locale];
  const textareaId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const fieldAttachments = attachments.filter((attachment) => attachment.field === field);

  async function upload(files: File[]) {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0 || disabled || uploading) return;
    if (attachments.length + images.length > 20) {
      onError(copy.tooManyImages);
      return;
    }
    setUploading(true);
    onUploadStateChange(true);
    onError("");
    try {
      const uploaded: DocumentTaskAttachment[] = [];
      for (const file of images) {
        const media = await uploadMediaFile(file, workspaceId);
        uploaded.push({
          id: `pending-${media.id}`,
          taskId: "",
          mediaId: media.id,
          field,
          position: fieldAttachments.length + uploaded.length,
          mimeType: media.mimeType,
          byteSize: media.byteSize,
          originalFilename: media.originalFilename,
          url: media.url,
          createdAt: media.createdAt,
        });
      }
      onAttachmentsChange((current) => [...current, ...uploaded]);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : copy.uploadFailed);
    } finally {
      setUploading(false);
      onUploadStateChange(false);
    }
  }

  function pasteImages(event: ClipboardEvent<HTMLTextAreaElement>) {
    const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    event.preventDefault();
    void upload(images);
  }

  return (
    <div className={styles.taskRichTextField}>
      <div>
        <label htmlFor={textareaId}>{label}</label>
        {!disabled && (
          <button
            type="button"
            aria-label={formatCopy(copy.addImage, {
              field: field === "description" ? copy.description : copy.acceptanceCriteria,
            })}
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
          >
            <ImagePlus size={14} /> {uploading ? copy.uploading : copy.image}
          </button>
        )}
      </div>
      <textarea
        id={textareaId}
        aria-label={field === "description" ? copy.description : copy.acceptanceCriteria}
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        placeholder={placeholder}
        onPaste={pasteImages}
        onChange={(event) => onTextChange(event.target.value)}
      />
      {!disabled && (
        <>
          <input
            ref={inputRef}
            className={styles.taskAttachmentInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            tabIndex={-1}
            onChange={(event) => {
              void upload([...(event.target.files ?? [])]);
              event.currentTarget.value = "";
            }}
          />
          <small className={styles.taskPasteHint}>
            {copy.pasteHint}
          </small>
        </>
      )}
      {fieldAttachments.length > 0 && (
        <div className={styles.taskAttachmentGrid}>
          {fieldAttachments.map((attachment) => (
            <figure key={`${attachment.field}:${attachment.mediaId}`}>
              <a
                href={`${attachment.url}?workspace=${encodeURIComponent(workspaceId)}`}
                target="_blank"
                rel="noreferrer"
                aria-label={formatCopy(copy.viewLarge, {
                  name: attachment.originalFilename ?? copy.attachment,
                })}
              >
                <Image
                  src={`${attachment.url}?workspace=${encodeURIComponent(workspaceId)}`}
                  alt={attachment.originalFilename ?? copy.todoAttachment}
                  width={240}
                  height={150}
                  unoptimized
                />
              </a>
              <figcaption>
                <span>{attachment.originalFilename ?? copy.pastedImage}</span>
                {!disabled && (
                  <button
                    type="button"
                    aria-label={copy.removeAttachment}
                    onClick={() => onAttachmentsChange((current) =>
                      current.filter((item) => item.mediaId !== attachment.mediaId
                        || item.field !== attachment.field),
                    )}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}

export function DocumentTasks({
  workspaceId,
  activeDocumentId,
  initialTasks,
  agents,
  documents,
  canCreate,
  canUpdate,
  canManage,
}: Props) {
  const { locale } = useI18n();
  const copy = TASK_COPY[locale];
  const statusCopy = statusLabels(locale);
  const priorityCopy = priorityLabels(locale);
  const eventCopy = eventLabels(locale);
  const activeAgents = useMemo(() => orderedActiveTaskAgents(agents), [agents]);
  const preferredAgentId = activeAgents[0]?.id ?? "";
  const [tasks, setTasks] = useState(initialTasks);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState(initialTasks.find(
    (task) => task.status === "ready",
  )?.id ?? null);
  const [filter, setFilter] = useState<TaskFilter>("todo");
  const [events, setEvents] = useState<DocumentTaskEvent[]>([]);
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [createDraft, setCreateDraft] = useState<TaskDraft>({
    title: "",
    description: "",
    acceptanceCriteria: "",
    attachments: [],
    priority: "normal",
    targetDocumentId: activeDocumentId,
    assignedAgentId: preferredAgentId,
    requiresReview: true,
    status: "ready",
    progress: 0,
    blocker: "",
    resultSummary: "",
  });
  const [pending, setPending] = useState(false);
  const [attachmentUploads, setAttachmentUploads] = useState(0);
  const [error, setError] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const openCount = tasks.filter((task) => !["completed", "cancelled"].includes(task.status)).length;
  const attachmentUploadState = useCallback((uploading: boolean) => {
    setAttachmentUploads((current) => Math.max(0, current + (uploading ? 1 : -1)));
  }, []);

  const workspaceRequest = useCallback((input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("x-nyxdoc-workspace-id", workspaceId);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return fetch(input, { ...init, headers, cache: "no-store" });
  }, [workspaceId]);

  const refreshTasks = useCallback(async () => {
    const response = await workspaceRequest("/api/tasks?limit=200");
    const body = await response.json().catch(() => ({})) as ApiBody;
    if (!response.ok || !body.tasks) throw new Error(body.error || copy.loadFailed);
    setTasks(body.tasks);
    return body.tasks;
  }, [copy.loadFailed, workspaceRequest]);

  const loadTaskDetails = useCallback(async (taskId: string) => {
    const response = await workspaceRequest(`/api/tasks/${encodeURIComponent(taskId)}`);
    const body = await response.json().catch(() => ({})) as ApiBody;
    if (!response.ok || !body.task) throw new Error(body.error || copy.loadFailed);
    setTasks((current) => current.map((task) => task.id === body.task!.id ? body.task! : task));
    setEvents(body.events ?? []);
    setDraft(taskDraft(body.task));
  }, [copy.loadFailed, workspaceRequest]);

  useEffect(() => {
    if (!open || !creating) return;
    window.setTimeout(() => titleInputRef.current?.focus(), 0);
  }, [creating, open]);

  const filteredTasks = useMemo(
    () => tasks.filter((task) => taskMatchesFilter(task, filter)),
    [filter, tasks],
  );

  function changeFilter(nextFilter: TaskFilter) {
    setFilter(nextFilter);
    setCreating(false);
    setError("");
    const visibleTasks = tasks.filter((task) => taskMatchesFilter(task, nextFilter));
    const nextTask = visibleTasks.find((task) => task.id === selectedTaskId)
      ?? visibleTasks[0]
      ?? null;
    setSelectedTaskId(nextTask?.id ?? null);
    if (!nextTask) {
      setDraft(null);
      setEvents([]);
      return;
    }
    void loadTaskDetails(nextTask.id).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : copy.loadFailed);
    });
  }

  function openPanel(create = false) {
    setError("");
    setOpen(true);
    setCreating(create);
    if (!create && selectedTaskId) {
      void loadTaskDetails(selectedTaskId).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : copy.loadFailed);
      });
    }
    if (create) {
      setCreateDraft((current) => ({
        ...current,
        title: "",
        description: "",
        acceptanceCriteria: "",
        attachments: [],
        targetDocumentId: activeDocumentId,
        assignedAgentId: preferredAgentId,
        status: "ready",
        progress: 0,
        blocker: "",
        resultSummary: "",
      }));
    }
  }

  async function createTask(event: FormEvent) {
    event.preventDefault();
    if (!createDraft.title.trim() || pending) return;
    setPending(true);
    setError("");
    try {
      const response = await workspaceRequest("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: createDraft.title,
          description: createDraft.description,
          acceptanceCriteria: createDraft.acceptanceCriteria,
          attachments: createDraft.attachments.map(({ mediaId, field }) => ({ mediaId, field })),
          priority: createDraft.priority,
          targetDocumentId: createDraft.targetDocumentId || null,
          assignedAgentId: createDraft.assignedAgentId || null,
          requiresReview: createDraft.requiresReview,
        }),
      });
      const body = await response.json().catch(() => ({})) as ApiBody;
      if (!response.ok || !body.task) throw new Error(body.error || copy.createFailed);
      const refreshed = await refreshTasks();
      setSelectedTaskId(body.task.id);
      setFilter("todo");
      setCreating(false);
      setDraft(taskDraft(body.task));
      if (!refreshed.some((task) => task.id === body.task!.id)) {
        setTasks((current) => [body.task!, ...current]);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.createFailed);
    } finally {
      setPending(false);
    }
  }

  async function patchTask(
    task: DocumentTask,
    changes: Record<string, unknown>,
  ) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const response = await workspaceRequest(`/api/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: task.version, ...changes }),
      });
      const body = await response.json().catch(() => ({})) as ApiBody;
      if (!response.ok || !body.task) throw new Error(body.error || copy.saveFailed);
      setTasks((current) => current.map((item) => item.id === body.task!.id ? body.task! : item));
      setDraft(taskDraft(body.task));
      await loadTaskDetails(body.task.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.saveFailed);
    } finally {
      setPending(false);
    }
  }

  async function saveTask(event: FormEvent) {
    event.preventDefault();
    if (!selectedTask || !draft) return;
    await patchTask(selectedTask, {
      title: draft.title,
      description: draft.description,
      acceptanceCriteria: draft.acceptanceCriteria,
      attachments: draft.attachments.map(({ mediaId, field }) => ({ mediaId, field })),
      priority: draft.priority,
      targetDocumentId: draft.targetDocumentId || null,
      assignedAgentId: draft.assignedAgentId || null,
      requiresReview: draft.requiresReview,
      status: draft.status,
      progress: draft.progress,
      blocker: draft.status === "blocked" ? draft.blocker : null,
      resultSummary: draft.resultSummary || null,
    });
  }

  return (
    <>
      <div className={styles.taskLauncher}>
        <button
          type="button"
          onClick={() => openPanel(false)}
          aria-label={formatCopy(copy.todoCount, { count: openCount })}
        >
          <ListTodo size={16} />
          <span>Agent To-do</span>
          {openCount > 0 && <em>{openCount}</em>}
        </button>
        {canCreate && (
          <button
            type="button"
            onClick={() => openPanel(true)}
            aria-label={copy.quickAdd}
            title={copy.quickAdd}
          >
            <Plus size={15} />
          </button>
        )}
      </div>

      {open && typeof document !== "undefined" && createPortal((
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !pending) setOpen(false);
        }}>
          <section
            className={styles.taskDialog}
            role="dialog"
            aria-modal="true"
            aria-label="Agent To-do"
          >
            <header>
              <div>
                <span><ListTodo size={21} /></span>
                <div>
                  <h2>Agent To-do</h2>
                  <p>{copy.dialogDescription}</p>
                </div>
              </div>
              <button type="button" onClick={() => setOpen(false)} disabled={pending} aria-label={copy.close}>
                <X size={19} />
              </button>
            </header>

            <div className={styles.taskBody}>
              <aside>
                <div className={styles.taskFilters}>
                  {([
                    ["todo", copy.statusReady],
                    ["active", copy.statusInProgress],
                    ["review", copy.statusReview],
                    ["completed", copy.statusCompleted],
                    ["all", copy.all],
                  ] as const).map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      className={filter === value ? styles.taskFilterActive : ""}
                      onClick={() => changeFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {canCreate && (
                  <button type="button" className={styles.taskCreateButton} onClick={() => setCreating(true)}>
                    <Plus size={15} /> {copy.newTodo}
                  </button>
                )}
                <div className={styles.taskList}>
                  {filteredTasks.length === 0
                    ? <p>{copy.noTasks}</p>
                    : filteredTasks.map((task) => (
                      <button
                        type="button"
                        key={task.id}
                        className={!creating && selectedTaskId === task.id ? styles.taskListActive : ""}
                        onClick={() => {
                          setCreating(false);
                          setSelectedTaskId(task.id);
                          setError("");
                          void loadTaskDetails(task.id).catch((reason: unknown) => {
                            setError(reason instanceof Error ? reason.message : copy.loadFailed);
                          });
                        }}
                      >
                        <span
                          className={`${styles.taskStatusDot} ${styles[`taskStatus_${task.status}`]}`}
                          aria-hidden="true"
                        />
                        <div>
                          <strong>{task.title}</strong>
                          <small>{taskPathLabel(task, copy)}</small>
                          <span>
                            {task.assignedAgentDisplayName ?? copy.unassigned} · {statusCopy[task.status]}
                          </span>
                        </div>
                        {task.priority !== "normal" && (
                          <em className={styles[`taskPriority_${task.priority}`]}>
                            {priorityCopy[task.priority]}
                          </em>
                        )}
                      </button>
                    ))}
                </div>
              </aside>

              <main>
                {creating ? (
                  <form className={styles.taskForm} onSubmit={createTask}>
                    <div className={styles.taskFormIntro}>
                      <span><Plus size={18} /></span>
                      <div>
                        <h3>{copy.newTodo}</h3>
                        <p>{copy.createIntro}</p>
                      </div>
                    </div>
                    <label className={styles.taskTitleField}>
                      <span>{copy.whatToDo}</span>
                      <input
                        ref={titleInputRef}
                        value={createDraft.title}
                        maxLength={200}
                        placeholder={copy.titlePlaceholder}
                        onChange={(event) => setCreateDraft((current) => ({
                          ...current,
                          title: event.target.value,
                        }))}
                      />
                    </label>
                    <div className={styles.taskFormGrid}>
                      <div className={styles.taskField}>
                        <span>{copy.targetDocument}</span>
                        <DocumentTargetPicker
                          ariaLabel={copy.chooseTarget}
                          documents={documents}
                          value={createDraft.targetDocumentId}
                          onChange={(targetDocumentId) => setCreateDraft((current) => ({
                            ...current,
                            targetDocumentId,
                          }))}
                        />
                      </div>
                      <label>
                        <span>{copy.assignee}</span>
                        <select
                          value={createDraft.assignedAgentId}
                          onChange={(event) => setCreateDraft((current) => ({
                            ...current,
                            assignedAgentId: event.target.value,
                          }))}
                        >
                          <option value="">{copy.unassignedClaim}</option>
                          {activeAgents.map((agent) => (
                            <option value={agent.id} key={agent.id}>
                              {agent.displayName} · {taskAgentAccessLabel(agent.accessProfile, locale)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>{copy.priority}</span>
                        <select
                          value={createDraft.priority}
                          onChange={(event) => setCreateDraft((current) => ({
                            ...current,
                            priority: event.target.value as DocumentTaskPriority,
                          }))}
                        >
                          {Object.entries(priorityCopy).map(([value, label]) => (
                            <option value={value} key={value}>{label}</option>
                          ))}
                        </select>
                      </label>
                      <label className={styles.taskCheckbox}>
                        <input
                          type="checkbox"
                          checked={createDraft.requiresReview}
                          onChange={(event) => setCreateDraft((current) => ({
                            ...current,
                            requiresReview: event.target.checked,
                          }))}
                        />
                        <span>{copy.reviewAfterSubmit}</span>
                      </label>
                    </div>
                    <TaskTextWithImages
                      attachments={createDraft.attachments}
                      field="description"
                      label={<>{copy.description} <small>{copy.optional}</small></>}
                      maxLength={10_000}
                      placeholder={copy.descriptionPlaceholder}
                      value={createDraft.description}
                      workspaceId={workspaceId}
                      onAttachmentsChange={(update) => setCreateDraft((current) => ({
                        ...current,
                        attachments: typeof update === "function"
                          ? update(current.attachments)
                          : update,
                      }))}
                      onError={setError}
                      onTextChange={(description) => setCreateDraft((current) => ({
                        ...current,
                        description,
                      }))}
                      onUploadStateChange={attachmentUploadState}
                    />
                    <TaskTextWithImages
                      attachments={createDraft.attachments}
                      field="acceptance_criteria"
                      label={<>{copy.acceptanceCriteria} <small>{copy.optional}</small></>}
                      maxLength={5_000}
                      placeholder={copy.acceptancePlaceholder}
                      value={createDraft.acceptanceCriteria}
                      workspaceId={workspaceId}
                      onAttachmentsChange={(update) => setCreateDraft((current) => ({
                        ...current,
                        attachments: typeof update === "function"
                          ? update(current.attachments)
                          : update,
                      }))}
                      onError={setError}
                      onTextChange={(acceptanceCriteria) => setCreateDraft((current) => ({
                        ...current,
                        acceptanceCriteria,
                      }))}
                      onUploadStateChange={attachmentUploadState}
                    />
                    <div className={styles.taskFormActions}>
                      <button type="button" onClick={() => setCreating(false)} disabled={pending}>{copy.cancel}</button>
                      <button
                        type="submit"
                        disabled={!createDraft.title.trim() || pending || attachmentUploads > 0}
                      >
                        <Plus size={15} /> {attachmentUploads > 0
                          ? copy.imageUploading
                          : pending ? copy.adding : copy.addTask}
                      </button>
                    </div>
                  </form>
                ) : selectedTask && draft ? (
                  <form className={styles.taskForm} onSubmit={saveTask}>
                    <div className={styles.taskDetailHeading}>
                      <div>
                        <span className={`${styles.taskStatusPill} ${styles[`taskStatus_${selectedTask.status}`]}`}>
                          {statusCopy[selectedTask.status]}
                        </span>
                        <small>
                          {formatCopy(copy.version, { version: selectedTask.version })}
                          {" · "}
                          {shortDate(selectedTask.updatedAt, locale)}
                        </small>
                      </div>
                      {selectedTask.assignedAgentDisplayName ? (
                        <span className={styles.taskAssignee}>
                          <UserAvatar
                            className={styles.taskAssigneeAvatar}
                            imageUrl={selectedTask.assignedAgentAvatarMediaId
                              ? `/api/media/${selectedTask.assignedAgentAvatarMediaId}`
                              : null}
                            name={selectedTask.assignedAgentDisplayName}
                          />
                          {selectedTask.assignedAgentDisplayName}
                        </span>
                      ) : (
                        <span className={styles.taskUnassigned}><Bot size={14} /> {copy.unassigned}</span>
                      )}
                    </div>
                    <label className={styles.taskTitleField}>
                      <span>{copy.taskTitle}</span>
                      <input
                        value={draft.title}
                        maxLength={200}
                        disabled={!canUpdate}
                        onChange={(event) => setDraft((current) => current && ({
                          ...current,
                          title: event.target.value,
                        }))}
                      />
                    </label>
                    <div className={styles.taskFormGrid}>
                      <label>
                        <span>{copy.status}</span>
                        <select
                          value={draft.status}
                          disabled={!canUpdate}
                          onChange={(event) => setDraft((current) => current && ({
                            ...current,
                            status: event.target.value as DocumentTaskStatus,
                          }))}
                        >
                          {Object.entries(statusCopy).map(([value, label]) => (
                            <option value={value} key={value}>{label}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>{copy.assignee}</span>
                        <select
                          value={draft.assignedAgentId}
                          disabled={!canUpdate}
                          onChange={(event) => setDraft((current) => current && ({
                            ...current,
                            assignedAgentId: event.target.value,
                          }))}
                        >
                          <option value="">{copy.unassigned}</option>
                          {activeAgents.map((agent) => (
                            <option value={agent.id} key={agent.id}>
                              {agent.displayName} · {taskAgentAccessLabel(agent.accessProfile, locale)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className={styles.taskField}>
                        <span>{copy.targetDocument}</span>
                        <DocumentTargetPicker
                          ariaLabel={copy.chooseTarget}
                          documents={documents}
                          value={draft.targetDocumentId}
                          disabled={!canUpdate}
                          onChange={(targetDocumentId) => setDraft((current) => current && ({
                            ...current,
                            targetDocumentId,
                          }))}
                        />
                      </div>
                      <label>
                        <span>{copy.priority}</span>
                        <select
                          value={draft.priority}
                          disabled={!canUpdate}
                          onChange={(event) => setDraft((current) => current && ({
                            ...current,
                            priority: event.target.value as DocumentTaskPriority,
                          }))}
                        >
                          {Object.entries(priorityCopy).map(([value, label]) => (
                            <option value={value} key={value}>{label}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <TaskTextWithImages
                      attachments={draft.attachments}
                      disabled={!canUpdate}
                      field="description"
                      label={copy.description}
                      maxLength={10_000}
                      value={draft.description}
                      workspaceId={workspaceId}
                      onAttachmentsChange={(update) => setDraft((current) => current && ({
                        ...current,
                        attachments: typeof update === "function"
                          ? update(current.attachments)
                          : update,
                      }))}
                      onError={setError}
                      onTextChange={(description) => setDraft((current) => current && ({
                        ...current,
                        description,
                      }))}
                      onUploadStateChange={attachmentUploadState}
                    />
                    <TaskTextWithImages
                      attachments={draft.attachments}
                      disabled={!canUpdate}
                      field="acceptance_criteria"
                      label={copy.acceptanceCriteria}
                      maxLength={5_000}
                      value={draft.acceptanceCriteria}
                      workspaceId={workspaceId}
                      onAttachmentsChange={(update) => setDraft((current) => current && ({
                        ...current,
                        attachments: typeof update === "function"
                          ? update(current.attachments)
                          : update,
                      }))}
                      onError={setError}
                      onTextChange={(acceptanceCriteria) => setDraft((current) => current && ({
                        ...current,
                        acceptanceCriteria,
                      }))}
                      onUploadStateChange={attachmentUploadState}
                    />
                    <div className={styles.taskFormGrid}>
                      <label>
                        <span>{copy.progress}</span>
                        <div className={styles.taskProgressField}>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={draft.progress}
                            disabled={!canUpdate || ["completed", "review"].includes(draft.status)}
                            onChange={(event) => setDraft((current) => current && ({
                              ...current,
                              progress: Number(event.target.value),
                            }))}
                          />
                          <strong>{draft.progress}%</strong>
                        </div>
                      </label>
                      <label className={styles.taskCheckbox}>
                        <input
                          type="checkbox"
                          checked={draft.requiresReview}
                          disabled={!canUpdate}
                          onChange={(event) => setDraft((current) => current && ({
                            ...current,
                            requiresReview: event.target.checked,
                          }))}
                        />
                        <span>{copy.requireReview}</span>
                      </label>
                    </div>
                    {draft.status === "blocked" && (
                      <label>
                        <span>{copy.blocker}</span>
                        <textarea
                          value={draft.blocker}
                          required
                          disabled={!canUpdate}
                          onChange={(event) => setDraft((current) => current && ({
                            ...current,
                            blocker: event.target.value,
                          }))}
                        />
                      </label>
                    )}
                    {selectedTask.resultSummary && (
                      <section className={styles.taskResult}>
                        <header><CheckCircle2 size={16} /><strong>{copy.agentResult}</strong></header>
                        <p>{selectedTask.resultSummary}</p>
                        {selectedTask.resultDocumentId && (
                          <Link href={workspaceHref(workspaceId, selectedTask.resultDocumentId)}>
                            <FileText size={14} />
                            {selectedTask.resultDocumentTitle ?? copy.resultDocument}
                            {selectedTask.resultRevisionNumber
                              ? ` · ${formatCopy(copy.revision, {
                                number: selectedTask.resultRevisionNumber,
                              })}`
                              : ""}
                          </Link>
                        )}
                      </section>
                    )}
                    <section className={styles.taskTimeline} aria-label={copy.history}>
                      <h4>{copy.history}</h4>
                      {events.length === 0
                        ? <p>{copy.noHistory}</p>
                        : events.map((event) => (
                          <article key={event.id}>
                            <span>
                              {event.eventType === "blocked"
                                ? <AlertCircle size={14} />
                                : event.eventType === "completed"
                                  ? <Check size={14} />
                                  : <CircleDashed size={14} />}
                            </span>
                            <div>
                              <strong>{eventCopy[event.eventType]}</strong>
                              <small>{event.actor.label} · {shortDate(event.createdAt, locale)}</small>
                              {event.message && <p>{event.message}</p>}
                            </div>
                          </article>
                        ))}
                    </section>
                    {canUpdate && (
                      <div className={styles.taskFormActions}>
                        {selectedTask.status === "review" && (
                          <button
                            type="button"
                            onClick={() => void patchTask(selectedTask, { status: "completed" })}
                            disabled={pending}
                          >
                            <Check size={15} /> {copy.markReviewed}
                          </button>
                        )}
                        {["completed", "cancelled"].includes(selectedTask.status) && (
                          <button
                            type="button"
                            onClick={() => void patchTask(selectedTask, { status: "ready" })}
                            disabled={pending}
                          >
                            <RotateCcw size={15} /> {copy.reopen}
                          </button>
                        )}
                        <button
                          type="submit"
                          disabled={!draft.title.trim() || pending || attachmentUploads > 0}
                        >
                          <Save size={15} /> {attachmentUploads > 0
                            ? copy.imageUploading
                            : pending ? copy.saving : copy.saveChanges}
                        </button>
                      </div>
                    )}
                    {!canUpdate && !canManage && (
                      <p className={styles.taskReadOnlyNotice}>{copy.readOnly}</p>
                    )}
                  </form>
                ) : (
                  <div className={styles.taskWelcome}>
                    <ListTodo size={34} />
                    <h3>{copy.chooseTask}</h3>
                    <p>{copy.recordContinuity}</p>
                  </div>
                )}
                {error && <div className={styles.taskError} role="status">{error}</div>}
              </main>
            </div>
          </section>
        </div>
      ), document.body)}
    </>
  );
}
