import { notFound } from "next/navigation";
import { SavedViewsPanel } from "@/components/workspace/saved-views-panel";
import type { SavedView } from "@/lib/collaboration/types";

const views: SavedView[] = ["검토할 문서", "최근 수정한 문서"].map((name, index) => ({
  id: `saved-view-e2e-${index + 1}`,
  name,
  query: { sort: "updated_desc", limit: 100 },
  visibility: "workspace",
  createdBy: { type: "human", id: "saved-view-user-e2e" },
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
}));

export default function SavedViewsE2EPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <SavedViewsPanel
    workspaceId="saved-view-workspace-e2e"
    userId="saved-view-user-e2e"
    views={views}
    agents={[]}
    documents={[]}
    canManage
    canManageAll
  />;
}
