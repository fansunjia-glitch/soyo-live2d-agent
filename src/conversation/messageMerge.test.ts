import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../types";
import { mergeTurnMessages } from "./messageMerge";

describe("mergeTurnMessages", () => {
  const firstTurn: ChatMessage[] = [{ role: "user", content: "第一句" }];
  const assistant: ChatMessage = { role: "assistant", content: "第一句回复" };

  it("preserves a newer user message appended while the old turn completes", () => {
    const current = [...firstTurn, { role: "user", content: "第二句" } satisfies ChatMessage];
    expect(mergeTurnMessages(current, firstTurn, assistant, false)).toEqual([
      firstTurn[0],
      assistant,
      current[1]
    ]);
  });

  it("keeps trailing messages when compaction replaces the old prefix", () => {
    const current = [...firstTurn, { role: "user", content: "第二句" } satisfies ChatMessage];
    expect(mergeTurnMessages(current, firstTurn, assistant, true)).toEqual([assistant, current[1]]);
  });

  it("fails safe without overwriting an unrelated history", () => {
    const current: ChatMessage[] = [{ role: "user", content: "另一个会话" }];
    expect(mergeTurnMessages(current, firstTurn, assistant, false)).toEqual(current);
  });
});
