"use client";

import { useState } from "react";
import { EditorLab } from "@/components/editor/editor-lab";
import { useFormSaveShortcut } from "@/components/workspace/use-form-save-shortcut";

const saveHarnessFormId = "editor-e2e-save-shortcut";

export function EditorE2EClient() {
  const [saveCount, setSaveCount] = useState(0);
  useFormSaveShortcut({
    enabled: true,
    formId: saveHarnessFormId,
    pending: false,
    valid: true,
  });

  return (
    <>
      <form
        id={saveHarnessFormId}
        onSubmit={(event) => {
          event.preventDefault();
          setSaveCount((count) => count + 1);
        }}
      >
        <output data-testid="save-shortcut-count" hidden>{saveCount}</output>
      </form>
      <EditorLab userName="Editor E2E" />
    </>
  );
}
