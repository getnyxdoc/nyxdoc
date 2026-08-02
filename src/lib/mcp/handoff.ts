import { createHash } from "node:crypto";
import type { DocumentTaskPriority } from "@/lib/tasks/types";

export type HandoffTodoInput = {
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  priority?: DocumentTaskPriority;
  assignedAgentId?: string | null;
  requiresReview?: boolean;
};

export type HandoffReferenceInput = {
  label?: string;
  url: string;
  note?: string;
};

export type HandoffInput = {
  title: string;
  summary: string;
  background?: string;
  decisions?: string[];
  requirements?: string[];
  acceptanceCriteria?: string[];
  risks?: string[];
  openQuestions?: string[];
  references?: HandoffReferenceInput[];
  todos?: HandoffTodoInput[];
  rawTranscript?: string;
};

function normalizedLines(values: readonly string[] | undefined) {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function appendTextSection(lines: string[], heading: string, value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) return;
  lines.push(`## ${heading}`, "", normalized, "");
}

function appendListSection(lines: string[], heading: string, values: readonly string[] | undefined) {
  const normalized = normalizedLines(values);
  if (!normalized.length) return;
  lines.push(`## ${heading}`, "", ...normalized.map((value) => `- ${value}`), "");
}

function transcriptFence(value: string) {
  const longest = Math.max(3, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length + 1));
  return "`".repeat(longest);
}

export function buildHandoffMarkdown(input: HandoffInput) {
  const lines = [
    "## Summary",
    "",
    input.summary.trim(),
    "",
  ];

  appendTextSection(lines, "Background", input.background);
  appendListSection(lines, "Decisions", input.decisions);
  appendListSection(lines, "Requirements", input.requirements);
  appendListSection(lines, "Acceptance Criteria", input.acceptanceCriteria);

  if (input.todos?.length) {
    lines.push("## Agent To-do", "");
    for (const todo of input.todos) {
      lines.push(`- ${todo.title.trim()}`);
      if (todo.description?.trim()) lines.push(`  - Context: ${todo.description.trim()}`);
      if (todo.acceptanceCriteria?.trim()) {
        lines.push(`  - Done when: ${todo.acceptanceCriteria.trim()}`);
      }
    }
    lines.push("");
  }

  appendListSection(lines, "Risks", input.risks);
  appendListSection(lines, "Open Questions", input.openQuestions);

  if (input.references?.length) {
    lines.push("## References", "");
    for (const reference of input.references) {
      const label = reference.label?.trim() || reference.url;
      const note = reference.note?.trim();
      lines.push(`- [${label}](${reference.url})${note ? ` — ${note}` : ""}`);
    }
    lines.push("");
  }

  if (input.rawTranscript?.trim()) {
    const transcript = input.rawTranscript.trim();
    const fence = transcriptFence(transcript);
    lines.push("## Raw Conversation", "", `${fence}text`, transcript, fence, "");
  }

  return `${lines.join("\n").trim()}\n`;
}

export function deriveHandoffRequestId(requestId: string, suffix: string) {
  const digest = createHash("sha256")
    .update(`${requestId}\0${suffix}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `handoff-${digest}`;
}
