"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Radio } from "lucide-react";
import { UserAvatar } from "@/components/profile/user-avatar";
import { useI18n } from "@/lib/i18n/client";
import { formatCopy } from "@/lib/i18n/copy";
import type { AgentPresence } from "@/lib/collaboration/presence";
import type { DocumentEvent } from "@/lib/documents/types";
import styles from "./workspace.module.css";

export function RealtimePresence({
  workspaceId,
  activeDocumentId,
  userId,
  editing,
  watchWorkspaceDocuments = false,
  onDocumentListInvalidated,
}: {
  workspaceId: string;
  activeDocumentId: string;
  userId: string;
  editing: boolean;
  watchWorkspaceDocuments?: boolean;
  onDocumentListInvalidated?: () => void;
}) {
  const { locale } = useI18n();
  const copy = {
    en: {
      reading: "reading",
      editing: "editing",
      drafting: "drafting",
      reviewing: "reviewing",
      agentsWorking: "{count} agents working",
      revision: "View revision {revision} from {actor}",
    },
    ko: {
      reading: "읽는 중",
      editing: "수정 중",
      drafting: "작성 중",
      reviewing: "검토 중",
      agentsWorking: "에이전트 {count}명 작업 중",
      revision: "{actor}의 새 리비전 {revision} 확인",
    },
    ja: {
      reading: "閲覧中",
      editing: "編集中",
      drafting: "作成中",
      reviewing: "レビュー中",
      agentsWorking: "エージェント{count}件が作業中",
      revision: "{actor}の新しいリビジョン{revision}を確認",
    },
  }[locale];
  const stateLabel: Record<AgentPresence["state"], string> = {
    reading: copy.reading,
    editing: copy.editing,
    drafting: copy.drafting,
    reviewing: copy.reviewing,
  };
  const router = useRouter();
  const [presence, setPresence] = useState<AgentPresence[]>([]);
  const [remoteChange, setRemoteChange] = useState<DocumentEvent | null>(null);

  useEffect(() => {
    const query = new URLSearchParams({ workspace: workspaceId });
    if (!watchWorkspaceDocuments) query.set("document", activeDocumentId);
    const events = new EventSource(`/api/realtime/events?${query.toString()}`);
    const handleReady = () => onDocumentListInvalidated?.();
    const handlePresence = (event: MessageEvent<string>) => {
      try {
        const body = JSON.parse(event.data) as { presence?: AgentPresence[] };
        setPresence(Array.isArray(body.presence) ? body.presence : []);
      } catch {
        // Ignore a malformed transient event and keep the last valid snapshot.
      }
    };
    const handleDocumentChange = (event: MessageEvent<string>) => {
      try {
        const change = JSON.parse(event.data) as DocumentEvent;
        onDocumentListInvalidated?.();
        if (change.documentId !== activeDocumentId || change.actorPrincipalId === userId) return;
        if (editing) setRemoteChange(change);
        else router.refresh();
      } catch {
        // The stream reconnects automatically; a single malformed event is non-fatal.
      }
    };
    events.addEventListener("ready", handleReady as EventListener);
    events.addEventListener("presence", handlePresence as EventListener);
    events.addEventListener("document-change", handleDocumentChange as EventListener);
    return () => events.close();
  }, [
    activeDocumentId,
    editing,
    onDocumentListInvalidated,
    router,
    userId,
    watchWorkspaceDocuments,
    workspaceId,
  ]);

  const activePresence = useMemo(() => {
    const byAgent = new Map<string, AgentPresence>();
    for (const entry of presence) {
      if (entry.documentId !== activeDocumentId) continue;
      const previous = byAgent.get(entry.agentId);
      if (!previous || previous.updatedAt < entry.updatedAt) byAgent.set(entry.agentId, entry);
    }
    return Array.from(byAgent.values());
  }, [activeDocumentId, presence]);

  return (
    <>
      {activePresence.length > 0 && (
        <div
          className={styles.presencePill}
          title={activePresence.map((entry) =>
            `${entry.displayName} · ${stateLabel[entry.state]}${entry.message ? ` · ${entry.message}` : ""}`,
          ).join("\n")}
        >
          <Radio size={13} aria-hidden="true" />
          <span className={styles.presenceAvatars}>
            {activePresence.slice(0, 3).map((entry) => (
              <UserAvatar
                key={entry.agentId}
                className={styles.presenceAvatar}
                imageUrl={entry.avatarMediaId ? `/api/media/${entry.avatarMediaId}` : null}
                name={entry.displayName}
              />
            ))}
          </span>
          <span>{activePresence.length === 1
            ? `${activePresence[0].displayName} ${stateLabel[activePresence[0].state]}`
            : formatCopy(copy.agentsWorking, { count: activePresence.length })}</span>
        </div>
      )}
      {remoteChange && (
        <button
          type="button"
          className={styles.remoteChangeNotice}
          onClick={() => {
            setRemoteChange(null);
            router.refresh();
          }}
        >
          <RefreshCw size={14} />
          {formatCopy(copy.revision, {
            actor: remoteChange.actorLabel,
            revision: remoteChange.revisionNumber,
          })}
        </button>
      )}
    </>
  );
}
