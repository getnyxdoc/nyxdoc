"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

const DRAG_THRESHOLD = 6;
const INTERACTIVE_INPUT_SELECTOR = "input, select, textarea";

export function useHorizontalDragScroll<T extends HTMLElement>() {
  const cleanupRef = useRef<(() => void) | null>(null);
  const draggedRef = useRef(false);

  useEffect(() => () => cleanupRef.current?.(), []);

  const onPointerDown = useCallback((event: ReactPointerEvent<T>) => {
    if (!event.isPrimary || event.button !== 0) return;
    // Touch devices already provide inertial scrolling for overflow containers.
    // Let the browser own that gesture so a swipe can start on a toolbar button
    // and continue smoothly on iOS instead of being cancelled mid-drag.
    if (event.pointerType === "touch") return;
    if ((event.target as HTMLElement).closest(INTERACTIVE_INPUT_SELECTOR)) return;

    const scroller = event.currentTarget;
    if (scroller.scrollWidth <= scroller.clientWidth + 1) return;

    cleanupRef.current?.();
    draggedRef.current = false;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startScrollLeft = scroller.scrollLeft;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    let dragging = false;

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const distance = moveEvent.clientX - startX;
      if (!dragging && Math.abs(distance) < DRAG_THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        draggedRef.current = true;
        scroller.dataset.dragging = "true";
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      moveEvent.preventDefault();
      scroller.scrollLeft = startScrollLeft - distance;
    };

    const stop = (stopEvent?: Event) => {
      if (stopEvent instanceof PointerEvent && stopEvent.pointerId !== pointerId) return;
      delete scroller.dataset.dragging;
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      cleanupRef.current = null;
      if (dragging) {
        window.setTimeout(() => {
          draggedRef.current = false;
        }, 0);
      }
    };

    cleanupRef.current = stop;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
  }, []);

  const onClickCapture = useCallback((event: ReactMouseEvent<T>) => {
    if (!draggedRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    draggedRef.current = false;
  }, []);

  const onDragStart = useCallback((event: ReactDragEvent<T>) => {
    event.preventDefault();
  }, []);

  return { onClickCapture, onDragStart, onPointerDown };
}
