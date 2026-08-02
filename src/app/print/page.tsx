import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PrintDocument } from "@/components/documents/print-document";
import { getCurrentSession, sessionEmailIsAccepted } from "@/data/session";
import { requireHumanDocumentPermission } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { getDocument } from "@/lib/documents/service";
import { getServerI18n } from "@/lib/i18n/server";
import { resolveUserWorkspace } from "@/lib/workspaces/service";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.print") };
}

export default async function PrintPage({
  searchParams,
}: {
  searchParams: Promise<{
    autoprint?: string;
    document?: string;
    workspace?: string;
  }>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect("/sign-in");
  if (!sessionEmailIsAccepted(session)) {
    redirect(`/verify-email?email=${encodeURIComponent(session.user.email)}`);
  }
  const { autoprint, document: documentId, workspace: workspaceId } = await searchParams;
  if (!documentId || !workspaceId) notFound();
  const workspace = resolveUserWorkspace(sqlite, {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
  }, { selector: workspaceId });
  requireHumanDocumentPermission(
    sqlite,
    workspace.id,
    documentId,
    session.user.id,
    "exports.create",
  );
  let document;
  try {
    document = getDocument(sqlite, workspace.id, documentId);
  } catch {
    notFound();
  }
  return (
    <PrintDocument
      autoprint={autoprint === "1"}
      content={document.content}
      documentId={document.id}
      documentTitle={document.title}
      workspaceId={workspace.id}
      workspaceName={workspace.name}
    />
  );
}
