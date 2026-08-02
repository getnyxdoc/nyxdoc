import { describe, expect, it } from "vitest";
import {
  AppBugTraceRecorder,
  requestTraceEvent,
  suggestBugReportCategory,
} from "@/lib/diagnostics/app-trace";

describe("app diagnostic trace", () => {
  it("keeps semantic request metadata without retaining the URL", () => {
    const event = requestTraceEvent({
      request: "https://app.nyxdoc.com/api/collaboration/commit?secret=value",
      method: "POST",
      status: 409,
      durationMs: 840,
      operationId: "11111111-1111-4111-8111-111111111111",
    });
    expect(event).toEqual({
      kind: "request",
      operation: "collaboration_commit",
      method: "POST",
      outcome: "client_error",
      status: 409,
      duration: "500_to_1999ms",
      operationId: "11111111-1111-4111-8111-111111111111",
    });
    expect(JSON.stringify(event)).not.toContain("secret");
  });

  it("freezes a recent ordered trace with relative timing", () => {
    let now = 1_000;
    const recorder = new AppBugTraceRecorder(() => now);
    recorder.record({ kind: "lifecycle", action: "document_opened" });
    now += 500;
    recorder.record({ kind: "sync", state: "error" });
    now += 250;
    expect(recorder.snapshot()).toEqual([
      {
        sequence: 0,
        offsetMs: -750,
        kind: "lifecycle",
        action: "document_opened",
      },
      {
        sequence: 1,
        offsetMs: -250,
        kind: "sync",
        state: "error",
      },
    ]);
  });

  it("suggests the category supported by the latest relevant event", () => {
    const recorder = new AppBugTraceRecorder();
    recorder.record({ kind: "tree", action: "collapse" });
    recorder.record({ kind: "sync", state: "error" });
    expect(suggestBugReportCategory(recorder.snapshot())).toBe("save_sync");
  });
});
