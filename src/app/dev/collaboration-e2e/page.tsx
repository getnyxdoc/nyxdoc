import { notFound } from "next/navigation";
import { CollaborationE2EClient } from "./collaboration-e2e-client";

export default async function CollaborationE2EPage({
  searchParams,
}: { searchParams: Promise<{ fixture?: string }> }) {
  if (process.env.NODE_ENV !== "development") notFound();

  return <CollaborationE2EClient caretFixture={(await searchParams).fixture === "caret"} />;
}
