"use client";

import { Dialog, FocusTrapRegion, type DialogProps } from "@ariakit/react";
import { useRef } from "react";

/** Modal isolation, keyboard looping, and focus restoration for existing overlays. */
export function ModalDialog({ render, ...props }: Omit<DialogProps, "ref" | "getPersistentElements">) {
  const dialogRef = useRef<HTMLDivElement>(null);
  return <Dialog
    portal={false}
    backdrop={false}
    aria-modal="true"
    data-nyx-motion="dialog"
    {...props}
    ref={dialogRef}
    render={<FocusTrapRegion enabled render={render} />}
    getPersistentElements={() => {
      // FocusTrapRegion renders its guards beside the dialog. Keep those two
      // guards focusable while Dialog makes the rest of the page inert.
      const dialog = dialogRef.current;
      return [dialog?.previousElementSibling, dialog?.nextElementSibling]
        .filter((element): element is Element => Boolean(element?.hasAttribute("data-focus-trap")));
    }}
  />;
}
