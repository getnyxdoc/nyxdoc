import { notFound } from "next/navigation";
import { CollaborationE2EClient } from "./collaboration-e2e-client";

export default function CollaborationE2EPage() {
  if (process.env.NODE_ENV !== "development") notFound();

  return <CollaborationE2EClient />;
}
