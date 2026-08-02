"use client";

import { useState } from "react";
import {
  NyxdocRichEditor,
  type NyxdocRichEditorChange,
} from "@/components/editor/editor-lab";
import type { NyxdocDocumentV2 } from "@/lib/editor/schema";

export function AgentLinkFixture({
  document,
  readOnly,
}: {
  document: NyxdocDocumentV2;
  readOnly: boolean;
}) {
  const [latestContent, setLatestContent] = useState<unknown>(document);
  return (
    <main>
      <NyxdocRichEditor
        ariaLabel="에이전트 링크 읽기"
        documentId="document-e2e"
        initialDocument={document}
        onChange={readOnly
          ? undefined
          : ({ content }: NyxdocRichEditorChange) => setLatestContent(content)}
        readOnly={readOnly}
        workspaceId="workspace-e2e"
      />
      {!readOnly && (
        <output data-testid="agent-link-content">
          {JSON.stringify(latestContent)}
        </output>
      )}
    </main>
  );
}
