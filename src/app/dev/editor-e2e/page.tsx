import { notFound } from "next/navigation";
import { EditorE2EClient } from "./editor-e2e-client";

export default function EditorE2EPage() {
  if (process.env.NODE_ENV !== "development") notFound();

  return <EditorE2EClient />;
}
