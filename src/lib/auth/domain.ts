export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function emailDomain(value: string) {
  const normalized = normalizeEmail(value);
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return null;
  return normalized.slice(at + 1);
}

export function isAllowedEmail(value: string, allowedDomain: string) {
  return emailDomain(value) === allowedDomain.trim().toLowerCase();
}
