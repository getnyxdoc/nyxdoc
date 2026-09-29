"use client";

import { useState } from "react";
import { Bot, Check, Copy } from "lucide-react";
import { buildAgentConnectionHandoff } from "@/lib/agents/handoff";
import { useI18n } from "@/lib/i18n/client";
import styles from "./settings.module.css";

/** The same handoff is available after creating access and when resuming setup. */
export function AgentSetupGuide(props: Parameters<typeof buildAgentConnectionHandoff>[0]) {
  const { locale } = useI18n();
  const [method, setMethod] = useState<"mcp" | "cli">("mcp");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const c = {
    ko: { title: "사용하는 에이전트에서 연결을 마무리하세요", hint: "아래 안내를 복사해 Codex, Claude Code 등 사용 중인 에이전트 대화에 붙여넣으세요.", mcp: "MCP 연결", cli: "CLI + 스킬", mcpHint: "원격 MCP를 지원하는 앱에서 사용합니다. 필요한 기능만 불러오는 경량 연결입니다.", cliHint: "로컬 파일과 터미널을 사용할 수 있는 에이전트용입니다. 닉스독을 쓸 때만 도구를 불러옵니다.", copy: "연결 안내 복사", copied: "복사됨 · 에이전트 대화에 붙여넣으세요", steps: ["안내 복사", "에이전트에 붙여넣기", "문서 조회 결과 확인"], warning: "새 연결 키가 포함됩니다. 신뢰하는 에이전트의 비공개 대화에만 전달하세요.", existing: "기존 키는 포함되지 않습니다. 에이전트에 저장된 키를 사용합니다. 키가 없다면 에이전트 관리에서 새 키를 발급하세요.", pending: "접근 권한은 준비됐습니다. 실제 연결은 에이전트가 워크스페이스와 문서를 조회한 결과로 확인하세요.", fallback: "복사하지 못했습니다. 안내를 펼쳐 직접 복사하세요.", show: "전달할 안내 보기" },
    en: { title: "Finish setup in your agent", hint: "Copy the guide into your conversation with Codex, Claude Code, or another agent.", mcp: "MCP connection", cli: "CLI + skill", mcpHint: "For apps supporting remote MCP. Compact mode loads capabilities only when needed.", cliHint: "For agents with local files and a terminal. Load Nyxdoc tools only when you use them.", copy: "Copy connection guide", copied: "Copied · paste into your agent", steps: ["Copy guide", "Paste into agent", "Check document access"], warning: "Contains a new connection key. Share only in your trusted agent's private conversation.", existing: "Existing key excluded. Your agent uses its stored key. If it has none, create a new key in Agent management.", pending: "Access is ready. Confirm the connection with your agent's workspace and document read results.", fallback: "Copy failed. Expand the guide and copy it manually.", show: "View connection guide" },
    ja: { title: "エージェントで接続を完了してください", hint: "案内をコピーしてCodex、Claude Codeなどの会話に貼り付けてください。", mcp: "MCP接続", cli: "CLI + スキル", mcpHint: "リモートMCP対応アプリ向け。必要な機能だけを読み込む軽量接続です。", cliHint: "ローカルファイルとターミナルを使えるエージェント向け。必要な時だけツールを読み込みます。", copy: "接続ガイドをコピー", copied: "コピー済み · エージェントに貼り付け", steps: ["案内をコピー", "エージェントに貼り付け", "文書アクセスを確認"], warning: "新しい接続キーを含みます。信頼するエージェントの非公開の会話にのみ共有してください。", existing: "既存キーは含みません。保存済みのキーを使います。キーがない場合はエージェント管理で発行してください。", pending: "アクセス設定は準備済みです。エージェントのワークスペースと文書の取得結果で接続を確認してください。", fallback: "コピーできませんでした。案内を開いて手動でコピーしてください。", show: "接続ガイドを表示" },
  }[locale];
  const mcpGuide = buildAgentConnectionHandoff({ ...props, locale });
  const cliInstructions = {
    ko: "닉스독을 CLI와 스킬로 설정해줘. 공식 저장소 https://github.com/getnyxdoc/nyxdoc 의 최신 안정 릴리스에서 cli/nyxdoc.mjs와 skills/nyxdoc/SKILL.md를 사용해. 이 컴퓨터의 실제 경로에 맞춰 스킬을 설치하고 NYXDOC_MCP_URL과 NYXDOC_MCP_BEARER_TOKEN을 안전하게 설정해. 아래 신원, 키와 권한을 재사용하고 새 에이전트를 만들지 마. CLI의 status와 list_agent_workspaces, 문서 검색·읽기로 검증해. 전체 MCP를 추가 등록하지 마. 기존 키를 사용할 수 없으면 추측하지 말고 알려줘.",
    en: "Set up Nyxdoc with its CLI and skill. Use cli/nyxdoc.mjs and skills/nyxdoc/SKILL.md from the latest stable release of https://github.com/getnyxdoc/nyxdoc. Install the skill with the actual local path and securely configure NYXDOC_MCP_URL and NYXDOC_MCP_BEARER_TOKEN. Reuse the identity, key and permissions below; do not create another agent. Verify with CLI status, list_agent_workspaces and document search/read. Do not register an additional full MCP server. Report a missing stored key rather than guessing it.",
    ja: "NyxdocをCLIとスキルで設定してください。https://github.com/getnyxdoc/nyxdoc の最新安定版のcli/nyxdoc.mjsとskills/nyxdoc/SKILL.mdを使い、実際のローカルパスでスキルを設定してください。NYXDOC_MCP_URLとNYXDOC_MCP_BEARER_TOKENを安全に設定し、以下のIDとキーを再利用してください。新しいエージェントは作らず、CLIのstatus、list_agent_workspaces、文書検索・取得で確認してください。追加の全MCPサーバーは登録しないでください。既存キーがなければ報告してください。",
  }[locale];
  const guide = method === "mcp" ? mcpGuide : `${cliInstructions}\n\n${JSON.stringify({ agentName: props.agentName, credentialName: props.credentialName, NYXDOC_MCP_URL: props.mcpUrl, NYXDOC_MCP_BEARER_TOKEN: props.token ?? "Use the existing stored secret; request a new key if unavailable.", workspaceName: props.workspaceName, role: props.role, documentScope: props.documentScope, keyAccess: props.keyAccess }, null, 2)}`;
  async function copyGuide() {
    try { await navigator.clipboard.writeText(guide); setCopied(true); setError(false); }
    catch { setError(true); setCopied(false); }
  }
  return <div className={styles.setupGuide}>
    <div className={styles.agentHandoffHeading}><span><Bot size={20} /></span><div><strong>{c.title}</strong><small>{c.hint}</small></div></div>
    <ol className={styles.setupSteps}>{c.steps.map((step, i) => <li key={step}><span>{i + 1}</span>{step}</li>)}</ol>
    <fieldset className={styles.setupMethods}><legend>{locale === "ko" ? "연결 방식" : locale === "ja" ? "接続方法" : "Connection method"}</legend>{(["mcp", "cli"] as const).map(value => <label key={value} data-selected={method === value}><input type="radio" name={`setup-method-${props.agentName}`} checked={method === value} onChange={() => { setMethod(value); setCopied(false); }} /><strong>{c[value]}</strong><small>{value === "mcp" ? c.mcpHint : c.cliHint}</small></label>)}</fieldset>
    <button className={styles.setupCopy} type="button" onClick={() => void copyGuide()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? c.copied : c.copy}</button>
    <p className={styles.setupSecretNote}>{props.token ? c.warning : c.existing}</p>
    <p className={styles.setupPending} role="status">{c.pending}</p>
    {error && <p role="alert">{c.fallback}</p>}
    <details open={error || undefined} className={styles.connectionAdvancedDetails}><summary>{c.show}</summary><pre className={styles.connectionCodeBlock}>{guide}</pre></details>
  </div>;
}
