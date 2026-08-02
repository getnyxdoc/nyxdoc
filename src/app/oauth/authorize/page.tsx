import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthShell, authStyles } from "@/components/auth/auth-shell";
import { McpOAuthConsent } from "@/components/auth/mcp-oauth-consent";
import { auth } from "@/lib/auth";
import { sqlite } from "@/lib/db/client";
import { getServerI18n } from "@/lib/i18n/server";
import {
  getMcpOAuthAuthorizationRequest,
  getMcpOAuthClient,
  getMcpOAuthConsentState,
  MCP_OAUTH_DEFAULT_SCOPE,
} from "@/lib/mcp/oauth";

const shellCopy = {
  en: {
    eyebrow: "MCP AUTHORIZATION",
    title: "Connect an external agent",
    description: "Choose exactly where this application may work in Nyxdoc.",
    invalid: "This authorization request is invalid or has expired.",
  },
  ko: {
    eyebrow: "MCP 연결 승인",
    title: "외부 에이전트 연결",
    description: "이 앱이 Nyxdoc에서 작업할 워크스페이스와 권한을 선택하세요.",
    invalid: "연결 요청이 올바르지 않거나 만료되었습니다.",
  },
  ja: {
    eyebrow: "MCP 接続の承認",
    title: "外部エージェントを接続",
    description: "このアプリが Nyxdoc で作業できる場所と権限を選択します。",
    invalid: "接続要求が無効、または期限切れです。",
  },
} as const;

export async function generateMetadata(): Promise<Metadata> {
  const { locale } = await getServerI18n();
  return { title: `${shellCopy[locale].title} · Nyxdoc` };
}

export default async function McpOAuthAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<{
    consent_code?: string;
    client_id?: string;
    scope?: string;
  }>;
}) {
  const { locale } = await getServerI18n();
  const text = shellCopy[locale];
  const params = await searchParams;
  const consentCode = params.consent_code?.trim() ?? "";
  const clientId = params.client_id?.trim() ?? "";
  const requestedScopes = params.scope?.trim() || MCP_OAUTH_DEFAULT_SCOPE;
  const query = new URLSearchParams({
    consent_code: consentCode,
    client_id: clientId,
    scope: requestedScopes,
  });
  const callbackURL = `/oauth/authorize?${query.toString()}`;
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) {
    redirect(`/sign-in?callbackURL=${encodeURIComponent(callbackURL)}`);
  }
  const authorization = consentCode
    ? getMcpOAuthAuthorizationRequest(sqlite, consentCode, session.user.id)
    : null;
  const client = authorization
    ? getMcpOAuthClient(sqlite, authorization.clientId)
    : null;
  if (!client) {
    return (
      <AuthShell
        eyebrow={text.eyebrow}
        title={text.title}
        description={text.description}
      >
        <div className={authStyles.error} role="alert">{text.invalid}</div>
      </AuthShell>
    );
  }
  let state: ReturnType<typeof getMcpOAuthConsentState>;
  try {
    state = getMcpOAuthConsentState(sqlite, {
      userId: session.user.id,
      clientId: authorization!.clientId,
      requestedScopes: authorization!.scopes.join(" "),
    });
  } catch {
    return (
      <AuthShell
        eyebrow={text.eyebrow}
        title={text.title}
        description={text.description}
      >
        <div className={authStyles.error} role="alert">{text.invalid}</div>
      </AuthShell>
    );
  }
  return (
    <AuthShell
      eyebrow={text.eyebrow}
      title={text.title}
      description={text.description}
    >
      <McpOAuthConsent
        client={client}
        consentCode={consentCode}
        requestedScopes={state.requestedScopes}
        workspaces={state.workspaces}
        initialWorkspaceIds={state.selectedWorkspaceIds}
        initialRole={state.role}
        agents={state.agents}
        initialAgent={state.initialAgent}
      />
    </AuthShell>
  );
}
