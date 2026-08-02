import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { EditorLab } from "@/components/editor/editor-lab";
import { getCurrentSession, sessionEmailIsAccepted } from "@/data/session";

export const metadata: Metadata = { title: "Editor Lab" };
export const dynamic = "force-dynamic";

export default async function EditorLabPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  const session = await getCurrentSession();
  if (!session) redirect("/sign-in");
  if (!sessionEmailIsAccepted(session)) {
    redirect(`/verify-email?email=${encodeURIComponent(session.user.email)}`);
  }

  return <EditorLab userName={session.user.name} />;
}
