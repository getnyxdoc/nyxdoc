import { describe, expect, it } from "vitest";
import { agentIdentityIdSchema } from "@/lib/agents/identifiers";

describe("agentIdentityIdSchema", () => {
  it("accepts both current UUIDs and preserved legacy identity IDs", () => {
    expect(agentIdentityIdSchema.parse("99fccd14-e5aa-4e4b-892c-a1d9886f2525"))
      .toBe("99fccd14-e5aa-4e4b-892c-a1d9886f2525");
    expect(agentIdentityIdSchema.parse("legacy-agent-01931125-2272-4fcb-86dd-fa360bbee83c"))
      .toBe("legacy-agent-01931125-2272-4fcb-86dd-fa360bbee83c");
  });

  it("rejects empty and unreasonably long identifiers", () => {
    expect(agentIdentityIdSchema.safeParse("   ").success).toBe(false);
    expect(agentIdentityIdSchema.safeParse("a".repeat(129)).success).toBe(false);
  });
});
