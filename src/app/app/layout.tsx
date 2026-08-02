import type { ReactNode } from "react";
import { AppBugReportProvider } from "@/components/diagnostics/app-bug-report-provider";
import { getDiagnosticsEnabled } from "@/lib/diagnostics/config";

export default function WorkspaceAppLayout({ children }: { children: ReactNode }) {
  return (
    <AppBugReportProvider enabled={getDiagnosticsEnabled()}>
      {children}
    </AppBugReportProvider>
  );
}
