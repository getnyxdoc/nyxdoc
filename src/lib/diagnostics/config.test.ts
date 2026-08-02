import { describe, expect, it } from "vitest";
import {
  diagnosticsDisabledResponse,
  getDiagnosticsEnabled,
} from "@/lib/diagnostics/config";

describe("diagnostics configuration", () => {
  it("keeps diagnostics enabled by default", () => {
    expect(getDiagnosticsEnabled(undefined)).toBe(true);
    expect(getDiagnosticsEnabled("")).toBe(true);
  });

  it.each(["false", "FALSE", "0", "no", "off"])(
    "disables diagnostics for %s",
    (value) => {
      expect(getDiagnosticsEnabled(value)).toBe(false);
    },
  );

  it.each(["true", "TRUE", "1", "yes", "on"])(
    "enables diagnostics for %s",
    (value) => {
      expect(getDiagnosticsEnabled(value)).toBe(true);
    },
  );

  it("rejects ambiguous values instead of silently enabling collection", () => {
    expect(() => getDiagnosticsEnabled("disabled")).toThrow(
      "NYXDOC_DIAGNOSTICS_ENABLED",
    );
  });

  it("uses a stable, non-discoverable response when collection is disabled", async () => {
    expect(diagnosticsDisabledResponse(true)).toBeNull();
    const response = diagnosticsDisabledResponse(false);
    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toEqual({
      code: "DIAGNOSTICS_DISABLED",
      error: "DIAGNOSTICS_DISABLED",
    });
  });
});
