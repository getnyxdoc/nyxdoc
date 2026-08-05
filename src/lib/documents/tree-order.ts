import type {
  DocumentSummary,
  DocumentTreeDropPosition,
} from "@/lib/documents/types";

export function reorderSiblingDocumentSummaries(
  documents: DocumentSummary[],
  documentId: string,
  targetDocumentId: string,
  position: DocumentTreeDropPosition,
) {
  if (documentId === targetDocumentId) return documents;
  const source = documents.find((document) => document.id === documentId);
  const target = documents.find((document) => document.id === targetDocumentId);
  if (!source || !target || source.parentDocumentId !== target.parentDocumentId) return documents;

  const originalIndex = new Map(documents.map((document, index) => [document.id, index]));
  const siblings = documents
    .filter((document) => document.parentDocumentId === source.parentDocumentId)
    .sort((left, right) =>
      left.treeOrder - right.treeOrder
      || (originalIndex.get(left.id) ?? 0) - (originalIndex.get(right.id) ?? 0));
  const previousOrder = siblings.map((document) => document.id);
  const nextOrder = previousOrder.filter((id) => id !== documentId);
  const targetIndex = nextOrder.indexOf(targetDocumentId);
  if (targetIndex < 0) return documents;
  nextOrder.splice(targetIndex + (position === "after" ? 1 : 0), 0, documentId);
  if (previousOrder.every((id, index) => nextOrder[index] === id)) return documents;

  const treeOrders = new Map(nextOrder.map((id, index) => [id, (index + 1) * 100]));
  return documents.map((document) => {
    const treeOrder = treeOrders.get(document.id);
    return treeOrder === undefined || treeOrder === document.treeOrder
      ? document
      : { ...document, treeOrder };
  });
}
