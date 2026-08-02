"use client";

import { useEffect } from "react";

export function useFormSaveShortcut({
  enabled,
  formId,
  onInvalid,
  pending,
  valid,
}: {
  enabled: boolean;
  formId: string;
  onInvalid?: () => void;
  pending: boolean;
  valid: boolean;
}) {
  useEffect(() => {
    if (!enabled) return;

    function handleSaveShortcut(event: KeyboardEvent) {
      if (
        event.isComposing ||
        event.altKey ||
        event.shiftKey ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "s"
      ) return;

      event.preventDefault();
      if (pending) return;
      if (!valid) {
        onInvalid?.();
        return;
      }

      const form = document.getElementById(formId);
      if (form instanceof HTMLFormElement) form.requestSubmit();
    }

    window.addEventListener("keydown", handleSaveShortcut);
    return () => window.removeEventListener("keydown", handleSaveShortcut);
  }, [enabled, formId, onInvalid, pending, valid]);
}
