const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

export function getDiagnosticsEnabled(
  configured = process.env.NYXDOC_DIAGNOSTICS_ENABLED,
) {
  const normalized = configured?.trim().toLowerCase();
  if (!normalized) return true;
  if (ENABLED_VALUES.has(normalized)) return true;
  if (DISABLED_VALUES.has(normalized)) return false;
  throw new Error(
    "NYXDOC_DIAGNOSTICS_ENABLED must be true/false, 1/0, yes/no, or on/off.",
  );
}

export function diagnosticsDisabledResponse(enabled = getDiagnosticsEnabled()) {
  if (enabled) return null;
  return Response.json({
    code: "DIAGNOSTICS_DISABLED",
    error: "DIAGNOSTICS_DISABLED",
  }, {
    status: 404,
    headers: { "cache-control": "no-store" },
  });
}
