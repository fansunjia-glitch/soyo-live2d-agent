import type { ChatMessage } from "../types";

/** Insert a completed assistant turn without overwriting messages appended
 * while its network/audio work was in flight. */
export function mergeTurnMessages(
  current: readonly ChatMessage[],
  turnInput: readonly ChatMessage[],
  assistant: ChatMessage,
  compacted: boolean
): ChatMessage[] {
  if (current.length < turnInput.length || !turnInput.every((message, index) => sameMessage(message, current[index]))) {
    return [...current];
  }
  const trailing = current.slice(turnInput.length);
  return [...(compacted ? [] : turnInput), assistant, ...trailing];
}

function sameMessage(left: ChatMessage, right: ChatMessage | undefined) {
  return left.role === right?.role && left.content === right.content;
}
