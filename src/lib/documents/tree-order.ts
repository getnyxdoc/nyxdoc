import type {
  DocumentSummary,
  DocumentTreeDropPosition,
} from "@/lib/documents/types";

export function moveDocumentSummaryInTree(
  documents: DocumentSummary[],
  documentId: string,
  targetDocumentId: string,
  position: DocumentTreeDropPosition,
) {
  if (documentId === targetDocumentId) return documents;
  const byId = new Map(documents.map((document) => [document.id, document]));
  const source = byId.get(documentId);
  const target = byId.get(targetDocumentId);
  if (!source || !target) return documents;

  const destinationParentDocumentId = position === "inside"
    ? target.id
    : target.parentDocumentId;
  let ancestorId = destinationParentDocumentId;
  const visited = new Set<string>();
  while (ancestorId && !visited.has(ancestorId)) {
    if (ancestorId === documentId) return documents;
    visited.add(ancestorId);
    ancestorId = byId.get(ancestorId)?.parentDocumentId ?? null;
  }

  const originalIndex = new Map(documents.map((document, index) => [document.id, index]));
  const parentOverrides = new Map([[documentId, destinationParentDocumentId]]);
  const parentOf = (document: DocumentSummary) => parentOverrides.get(document.id)
    ?? document.parentDocumentId;
  const sortedSiblings = (parentDocumentId: string | null) => documents
    .filter((document) => parentOf(document) === parentDocumentId)
    .sort((left, right) =>
      left.treeOrder - right.treeOrder
      || (originalIndex.get(left.id) ?? 0) - (originalIndex.get(right.id) ?? 0));

  const treeOrders = new Map<string, number>();
  if (source.parentDocumentId !== destinationParentDocumentId) {
    sortedSiblings(source.parentDocumentId)
      .forEach((document, index) => treeOrders.set(document.id, (index + 1) * 100));
  }

  const destinationOrder = sortedSiblings(destinationParentDocumentId)
    .map((document) => document.id)
    .filter((id) => id !== documentId);
  if (position === "inside") {
    destinationOrder.push(documentId);
  } else {
    const targetIndex = destinationOrder.indexOf(targetDocumentId);
    if (targetIndex < 0) return documents;
    destinationOrder.splice(targetIndex + (position === "after" ? 1 : 0), 0, documentId);
  }
  destinationOrder.forEach((id, index) => treeOrders.set(id, (index + 1) * 100));

  let changed = false;
  const nextDocuments = documents.map((document) => {
    const parentDocumentId = parentOf(document);
    const treeOrder = treeOrders.get(document.id) ?? document.treeOrder;
    if (parentDocumentId === document.parentDocumentId && treeOrder === document.treeOrder) {
      return document;
    }
    changed = true;
    return { ...document, parentDocumentId, treeOrder };
  });
  if (!changed) return documents;

  return nextDocuments;
}
