import type { DocumentActor, DocumentMutationSource } from "@/lib/documents/types";

export function humanDocumentActor(
  user: { id: string; name?: string | null; email: string; image?: string | null },
  source: DocumentMutationSource = "web",
): DocumentActor {
  const mediaMatch = user.image?.match(/^\/api\/media\/([0-9a-f-]{36})$/i);
  return {
    type: "human",
    userId: user.id,
    principalId: user.id,
    avatarMediaId: mediaMatch?.[1] ?? null,
    label: user.name?.trim() || user.email,
    source,
  };
}
