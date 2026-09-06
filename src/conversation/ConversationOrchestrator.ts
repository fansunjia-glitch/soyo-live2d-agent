import { agentFetch, apiUrl } from "../api";
import { SpeechPlayer, type SpeechProgress } from "../audio/SpeechPlayer";
import { normalizePerformancePlan } from "../performance/types";
import type { AgentAction, AgentEmotion, AgentReply, ChatMessage } from "../types";
import { normalizeDeviceRequest } from "../device-control/DeviceBridge";
import type { DeviceAction, DeviceToolResult } from "../device-control/types";

export type ConversationPhase =
  | "idle"
  | "listening"
  | "thinking"
  | "buffering"
  | "speaking"
  | "interrupted"
  | "error";

export type RunTurnInput = {
  messages: ChatMessage[];
  memorySummary?: string;
  imageDataUrl?: string;
  llmModel: string;
  temperature: number;
  ttsModel: string;
  resolveVoice: (emotion: AgentEmotion) => string | undefined;
  deviceCapabilities?: DeviceAction[];
  relationshipScopeId?: string;
  relationshipContext?: string;
  resolveDeviceRequest?: (request: NonNullable<AgentReply["deviceRequest"]>, signal: AbortSignal) => Promise<DeviceToolResult>;
};

export type TurnCallbacks = {
  onPhase?: (phase: ConversationPhase) => void;
  onStatus?: (status: string) => void;
  onReply?: (reply: AgentReply) => void;
  onAudioStart?: (voice: string) => void;
  onAudioProgress?: (progress: SpeechProgress) => void;
  onAudioEnd?: () => void;
};

type SpeechPlayback = Pick<SpeechPlayer, "play" | "stop" | "dispose">
  & Partial<Pick<SpeechPlayer, "resume">>;

export type ConversationOrchestratorOptions = {
  fetcher?: typeof fetch;
  speechPlayer?: SpeechPlayback;
  chatEndpoint?: string;
  ttsEndpoint?: string;
};

type ActiveTurn = {
  id: number;
  abortController: AbortController;
  rejectPlayback?: (error: Error) => void;
};

export class TurnInterruptedError extends Error {
  constructor(message = "Conversation turn was interrupted.") {
    super(message);
    this.name = "TurnInterruptedError";
  }
}

const FALLBACK_REPLY = {
  reply: "嗯，我听到了。可以再慢一点告诉我吗？",
  ttsInstruction: "语气温柔、稍微迟疑，像在认真倾听。"
};
const EMOTIONS: readonly AgentEmotion[] = [
  "neutral",
  "happy",
  "sad",
  "shy",
  "worried",
  "surprised",
  "determined"
];
const ACTIONS: readonly AgentAction[] = ["idle", "nod", "wave", "think", "comfort", "deny", "excited"];

/** Coordinates one cancellable chat -> speech -> presentation turn. */
export class ConversationOrchestrator {
  private readonly fetcher: typeof fetch;
  private readonly speechPlayer: SpeechPlayback;
  private readonly chatEndpoint: string;
  private readonly ttsEndpoint: string;
  private active: ActiveTurn | null = null;
  private nextId = 0;

  constructor(options: ConversationOrchestratorOptions = {}) {
    this.fetcher = options.fetcher ?? agentFetch;
    this.speechPlayer = options.speechPlayer ?? new SpeechPlayer();
    this.chatEndpoint = options.chatEndpoint ?? apiUrl("/api/chat");
    this.ttsEndpoint = options.ttsEndpoint ?? apiUrl("/api/tts");
  }

  get isActive() {
    return this.active !== null;
  }

  /** Prime Web Audio synchronously from a click/tap before network latency. */
  async resumeAudio(): Promise<void> {
    await this.speechPlayer.resume?.();
  }

  async run(input: RunTurnInput, callbacks: TurnCallbacks = {}): Promise<AgentReply> {
    this.interrupt("A newer conversation turn started.");
    const turn: ActiveTurn = {
      id: ++this.nextId,
      abortController: new AbortController()
    };
    this.active = turn;
    const turnId = createTurnId(turn.id);

    try {
      callbacks.onPhase?.("thinking");
      callbacks.onStatus?.("思考中");
      const requestChat = async (deviceResult?: DeviceToolResult) => {
        const chatResponse = await abortable(this.fetcher(this.chatEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: turn.abortController.signal,
          body: JSON.stringify({
            messages: input.messages,
            turnId,
            memorySummary: input.memorySummary,
            imageDataUrl: input.imageDataUrl,
            model: input.llmModel,
            temperature: input.temperature,
            deviceCapabilities: input.deviceCapabilities ?? [],
            relationshipScopeId: input.relationshipScopeId,
            relationshipContext: input.relationshipContext,
            deviceResult
          })
        }), turn.abortController.signal);
        await ensureResponse(chatResponse, "对话生成失败", turn.abortController.signal);
        this.assertCurrent(turn);
        const payload: unknown = await abortable(chatResponse.json(), turn.abortController.signal);
        return normalizeAgentReply(payload, turnId);
      };

      let reply = await requestChat();
      if (reply.deviceRequest && input.resolveDeviceRequest) {
        callbacks.onStatus?.(`等待 iPhone 确认 · ${reply.deviceRequest.reason}`);
        callbacks.onPhase?.("thinking");
        let deviceResult: DeviceToolResult;
        try {
          deviceResult = await abortable(
            input.resolveDeviceRequest(reply.deviceRequest, turn.abortController.signal),
            turn.abortController.signal
          );
        } catch (error) {
          if (turn.abortController.signal.aborted) throw error;
          deviceResult = {
            action: reply.deviceRequest.action,
            ok: false,
            message: toError(error).message.slice(0, 500),
            data: {}
          };
        }
        this.assertCurrent(turn);
        callbacks.onStatus?.("整理 iPhone 返回结果");
        reply = await requestChat(deviceResult);
        // One user turn may execute at most one phone action.
        if (reply.deviceRequest) reply = { ...reply, deviceRequest: undefined };
      }
      this.assertCurrent(turn);
      callbacks.onReply?.(reply);
      callbacks.onPhase?.("buffering");
      callbacks.onStatus?.("生成语音");

      const ttsResponse = await abortable(this.fetcher(this.ttsEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: turn.abortController.signal,
        body: JSON.stringify({
          text: reply.reply,
          instruction: reply.ttsInstruction,
          emotion: reply.emotion,
          model: input.ttsModel,
          voice: input.resolveVoice(reply.emotion)
        })
      }), turn.abortController.signal);
      await ensureResponse(ttsResponse, "语音生成失败", turn.abortController.signal);
      const audioBlob = await abortable(ttsResponse.blob(), turn.abortController.signal);
      this.assertCurrent(turn);
      const voice = ttsResponse.headers.get("X-Soyo-TTS-Voice") ?? "voice";

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let started = false;
        const isCurrent = () => this.active?.id === turn.id && !turn.abortController.signal.aborted;
        const settle = (error?: Error) => {
          if (settled) return;
          settled = true;
          turn.rejectPlayback = undefined;
          if (error) {
            reject(error);
            return;
          }
          if (!isCurrent()) {
            reject(interruptionFrom(turn.abortController.signal));
            return;
          }
          try {
            callbacks.onAudioEnd?.();
            resolve();
          } catch (callbackError) {
            reject(toError(callbackError));
          }
        };
        const notifyStart = () => {
          if (settled || started || !isCurrent()) return;
          started = true;
          callbacks.onPhase?.("speaking");
          callbacks.onStatus?.(`说话中 · ${voice}`);
          callbacks.onAudioStart?.(voice);
        };
        turn.rejectPlayback = (error) => settle(error);

        let playbackStart: Promise<void>;
        try {
          playbackStart = this.speechPlayer.play(audioBlob, {
            onStart: () => {
              notifyStart();
            },
            onProgress: (progress) => {
              if (!settled && isCurrent()) callbacks.onAudioProgress?.(progress);
            },
            onEnded: () => {
              // A very short clip can end before a queued start callback. Preserve
              // a coherent start -> end lifecycle and suppress any late start.
              notifyStart();
              settle();
            },
            onError: (error) => settle(error)
          });
        } catch (error) {
          settle(toError(error));
          return;
        }
        void Promise.resolve(playbackStart).then(notifyStart, (error: unknown) => settle(toError(error)));
      });

      this.assertCurrent(turn);
      this.active = null;
      callbacks.onPhase?.("idle");
      callbacks.onStatus?.("空闲");
      return reply;
    } catch (error) {
      if (this.active?.id === turn.id) this.active = null;
      if (turn.abortController.signal.aborted || error instanceof TurnInterruptedError) {
        throw error instanceof TurnInterruptedError ? error : new TurnInterruptedError();
      }
      callbacks.onPhase?.("error");
      throw toError(error);
    }
  }

  interrupt(message = "Conversation turn was interrupted."): boolean {
    const turn = this.active;
    if (!turn) return false;
    const interruption = new TurnInterruptedError(message);
    this.active = null;
    turn.abortController.abort(interruption);
    turn.rejectPlayback?.(interruption);
    this.speechPlayer.stop();
    return true;
  }

  async dispose(): Promise<void> {
    this.interrupt("Conversation orchestrator was disposed.");
    await this.speechPlayer.dispose();
  }

  private assertCurrent(turn: ActiveTurn): void {
    if (this.active?.id !== turn.id || turn.abortController.signal.aborted) {
      throw new TurnInterruptedError();
    }
  }
}

/** Normalizes the JSON boundary before values reach TTS or Live2D. */
export function normalizeAgentReply(value: unknown, turnId?: string): AgentReply {
  const raw = record(value);
  const reply = boundedText(raw?.reply, 4_000) ?? FALLBACK_REPLY.reply;
  const emotion = enumValue(raw?.emotion, EMOTIONS) ?? "neutral";
  const action = enumValue(raw?.action, ACTIONS) ?? "idle";
  const ttsInstruction = boundedText(raw?.ttsInstruction, 100) ?? FALLBACK_REPLY.ttsInstruction;
  const memorySummary = boundedText(raw?.memorySummary, 800, true) ?? "";
  // Never let a malformed flag discard local history without an accompanying summary.
  const messagesCompacted = raw?.messagesCompacted === true && memorySummary.length > 0;
  const fallback = { reply, emotion, action, ttsInstruction, turnId };
  const deviceRequest = normalizeDeviceRequest(raw?.deviceRequest);
  const memoryPatch = record(raw?.memoryPatch);

  return {
    reply,
    emotion,
    action,
    ttsInstruction,
    memorySummary,
    messagesCompacted,
    ...(deviceRequest ? { deviceRequest } : {}),
    ...(memoryPatch ? { memoryPatch } : {}),
    performance: normalizePerformancePlan(raw?.performance, fallback)
  };
}

async function ensureResponse(response: Response, fallback: string, signal: AbortSignal): Promise<void> {
  if (response.ok) return;
  const text = await abortable(response.text(), signal);
  throw new Error(text || `${fallback} (${response.status})`);
}

function abortable<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(interruptionFrom(signal)));

    signal.addEventListener("abort", onAbort, { once: true });
    // Promise.resolve installs both handlers even if the underlying operation
    // ignores AbortSignal, preventing a late rejection from becoming unhandled.
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
    if (signal.aborted) onAbort();
  });
}

function interruptionFrom(signal: AbortSignal): TurnInterruptedError {
  return signal.reason instanceof TurnInterruptedError ? signal.reason : new TurnInterruptedError();
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("请求失败");
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

function boundedText(value: unknown, maximumLength: number, allowEmpty = false): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, maximumLength);
  return normalized || allowEmpty ? normalized : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function createTurnId(sequence: number) {
  return globalThis.crypto?.randomUUID?.() ?? `turn-${Date.now()}-${sequence}`;
}
