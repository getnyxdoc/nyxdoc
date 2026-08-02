export type DocumentNodeIdRepair = {
  path: number[];
  previousId: string | null;
  nextId: string;
  reason: "missing" | "duplicate";
};

export type DocumentNodeIdCreator = (input: {
  attempt: number;
  path: readonly number[];
  previousId: string | null;
  reason: DocumentNodeIdRepair["reason"];
}) => string;

function freshId(
  seen: Set<string>,
  idCreator: DocumentNodeIdCreator,
  previousId: string | null,
  path: readonly number[],
  reason: DocumentNodeIdRepair["reason"],
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = idCreator({ attempt, path, previousId, reason });
    if (candidate && !seen.has(candidate)) return candidate;
  }
  throw new Error("고유한 문서 노드 ID를 만들지 못했습니다.");
}

export function documentNodeIdRepairs(
  value: readonly unknown[],
  idCreator: DocumentNodeIdCreator,
) {
  const seen = new Set<string>();
  const repairs: DocumentNodeIdRepair[] = [];

  function visit(node: unknown, path: number[]) {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const isElement = Array.isArray(record.children) && typeof record.text !== "string";
    if (isElement) {
      const currentId = typeof record.id === "string" && record.id.length > 0
        ? record.id
        : null;
      if (currentId === null) {
        const nextId = freshId(seen, idCreator, null, path, "missing");
        repairs.push({
          path: [...path],
          previousId: null,
          nextId,
          reason: "missing",
        });
        seen.add(nextId);
      } else if (seen.has(currentId)) {
        const nextId = freshId(seen, idCreator, currentId, path, "duplicate");
        repairs.push({
          path: [...path],
          previousId: currentId,
          nextId,
          reason: "duplicate",
        });
        seen.add(nextId);
      } else {
        seen.add(currentId);
      }
    }
    if (Array.isArray(record.children)) {
      record.children.forEach((child, index) => visit(child, [...path, index]));
    }
  }

  value.forEach((node, index) => visit(node, [index]));
  return repairs;
}

export function repairDocumentNodeIds<T extends readonly unknown[]>(
  value: T,
  idCreator: DocumentNodeIdCreator,
) {
  const repairs = documentNodeIdRepairs(value, idCreator);
  if (repairs.length === 0) return { value, repairs };

  const repaired = structuredClone(value) as unknown as unknown[];
  for (const repair of repairs) {
    let node: unknown = repaired[repair.path[0]];
    for (const index of repair.path.slice(1)) {
      const record = node as { children: unknown[] };
      node = record.children[index];
    }
    (node as { id: string }).id = repair.nextId;
  }
  return { value: repaired as unknown as T, repairs };
}
