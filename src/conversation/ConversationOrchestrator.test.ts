import { describe, expect, it, vi } from "vitest";
import type { SpeechPlayerCallbacks } from "../audio/SpeechPlayer";
import {
  ConversationOrchestrator,
  normalizeAgentReply,
  TurnInterruptedError,
  type ConversationPhase
} from "./ConversationOrchestrator";

function input() {
  return {
    messages: [{ role: "user" as const, content: "你好" }],
    llmModel: "qwen",
    temperature: 0.5,
    ttsModel: "cosyvoice",
    resolveVoice: () => "voice"
  };
}

describe("ConversationOrchestrator", () => {
  it("runs chat, speech and synchronized phase callbacks", async () => {
    const reply = {
      reply: "你好呀",
      emotion: "happy" as const,
      action: "wave" as const,
      ttsInstruction: "温柔",
      memorySummary: "",
      messagesCompacted: false
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(reply), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Blob(["audio"]), {
        status: 200,
        headers: { "X-Soyo-TTS-Voice": "soyo-soft" }
      }));
    const speechPlayer = {
      stop: vi.fn(),
      dispose: vi.fn(async () => undefined),
      play: vi.fn(async (_blob: Blob, callbacks: { onStart?: () => void; onEnded?: () => void }) => {
        callbacks.onStart?.();
        callbacks.onEnded?.();
      })
    };
    const phases: ConversationPhase[] = [];
    const orchestrator = new ConversationOrchestrator({ fetcher, speechPlayer });

    const result = await orchestrator.run(input(), { onPhase: (phase) => phases.push(phase) });

    expect(result).toMatchObject(reply);
    expect(result.performance).toMatchObject({
      schemaVersion: 2,
      reply: reply.reply,
      affect: { primary: reply.emotion },
      cues: [{ action: reply.action }]
    });
    expect(phases).toEqual(["thinking", "buffering", "speaking", "idle"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(speechPlayer.play).toHaveBeenCalledOnce();
  });

  it("executes at most one authenticated iPhone tool before the final reply", async () => {
    const toolReply = {
      reply: "我先确认一下手机信息。",
      emotion: "neutral",
      action: "think",
      ttsInstruction: "自然",
      memorySummary: "",
      messagesCompacted: false,
      deviceRequest: { action: "device.info", params: {}, reason: "回答前确认设备" }
    };
    const finalReply = {
      reply: "你的 iPhone 已连接。",
      emotion: "happy",
      action: "nod",
      ttsInstruction: "轻快",
      memorySummary: "",
      messagesCompacted: false,
      // A second tool request must be ignored by the one-action turn budget.
      deviceRequest: { action: "agent.ping", params: {}, reason: "再次检查" }
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(toolReply), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(finalReply), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Blob(["audio"]), { status: 200 }));
    const speechPlayer = {
      stop: vi.fn(),
      dispose: vi.fn(async () => undefined),
      play: vi.fn(async (_blob: Blob, callbacks: SpeechPlayerCallbacks) => {
        callbacks.onStart?.();
        callbacks.onEnded?.();
      })
    };
    const resolveDeviceRequest = vi.fn(async () => ({
      action: "device.info" as const,
      ok: true,
      message: "connected",
      data: { model: "iPhone" }
    }));
    const orchestrator = new ConversationOrchestrator({ fetcher, speechPlayer });

    const result = await orchestrator.run({
      ...input(),
      deviceCapabilities: ["device.info"],
      relationshipScopeId: "session-1",
      relationshipContext: "{\"preferredName\":\"Soyo\"}",
      resolveDeviceRequest
    });

    expect(result.reply).toBe(finalReply.reply);
    expect(result.deviceRequest).toBeUndefined();
    expect(resolveDeviceRequest).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(3);
    const firstBody = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(firstBody).toMatchObject({
      deviceCapabilities: ["device.info"],
      relationshipScopeId: "session-1"
    });
    expect(firstBody.deviceResult).toBeUndefined();
    expect(secondBody.deviceResult).toMatchObject({ action: "device.info", ok: true });
  });

  it("interrupts an in-flight request", async () => {
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const speechPlayer = {
      stop: vi.fn(),
      dispose: vi.fn(async () => undefined),
      play: vi.fn(async () => undefined)
    };
    const orchestrator = new ConversationOrchestrator({ fetcher: fetcher as typeof fetch, speechPlayer });
    const running = orchestrator.run(input());
    const rejection = expect(running).rejects.toBeInstanceOf(TurnInterruptedError);

    expect(orchestrator.interrupt()).toBe(true);
    expect(signal?.aborted).toBe(true);
    await rejection;
    expect(orchestrator.isActive).toBe(false);
  });

  it("settles an end-before-start race once and ignores late playback callbacks", async () => {
    const reply = {
      reply: "很短",
      emotion: "neutral",
      action: "idle",
      ttsInstruction: "自然",
      memorySummary: "",
      messagesCompacted: false
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(reply), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Blob(["audio"]), { status: 200 }));
    let playbackCallbacks: SpeechPlayerCallbacks | undefined;
    let resolvePlaybackStart: (() => void) | undefined;
    const speechPlayer = {
      stop: vi.fn(),
      dispose: vi.fn(async () => undefined),
      play: vi.fn((_blob: Blob, callbacks: SpeechPlayerCallbacks) => {
        playbackCallbacks = callbacks;
        return new Promise<void>((resolve) => {
          resolvePlaybackStart = resolve;
        });
      })
    };
    const phases: ConversationPhase[] = [];
    const onAudioStart = vi.fn();
    const onAudioEnd = vi.fn();
    const orchestrator = new ConversationOrchestrator({ fetcher, speechPlayer });
    const running = orchestrator.run(input(), {
      onPhase: (phase) => phases.push(phase),
      onAudioStart,
      onAudioEnd
    });

    await vi.waitFor(() => expect(playbackCallbacks).toBeDefined());
    playbackCallbacks?.onEnded?.();
    playbackCallbacks?.onStart?.();
    playbackCallbacks?.onEnded?.();

    await expect(running).resolves.toMatchObject({ reply: "很短" });
    expect(onAudioStart).toHaveBeenCalledOnce();
    expect(onAudioEnd).toHaveBeenCalledOnce();
    expect(phases).toEqual(["thinking", "buffering", "speaking", "idle"]);

    resolvePlaybackStart?.();
    await Promise.resolve();
    expect(onAudioStart).toHaveBeenCalledOnce();
  });

  it("suppresses start, progress and end callbacks after playback is interrupted", async () => {
    const reply = {
      reply: "稍等",
      emotion: "neutral",
      action: "idle",
      ttsInstruction: "自然",
      memorySummary: "",
      messagesCompacted: false
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(reply), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Blob(["audio"]), { status: 200 }));
    let playbackCallbacks: SpeechPlayerCallbacks | undefined;
    const speechPlayer = {
      stop: vi.fn(),
      dispose: vi.fn(async () => undefined),
      play: vi.fn((_blob: Blob, callbacks: SpeechPlayerCallbacks) => {
        playbackCallbacks = callbacks;
        return new Promise<void>(() => undefined);
      })
    };
    const onAudioStart = vi.fn();
    const onAudioProgress = vi.fn();
    const onAudioEnd = vi.fn();
    const orchestrator = new ConversationOrchestrator({ fetcher, speechPlayer });
    const running = orchestrator.run(input(), { onAudioStart, onAudioProgress, onAudioEnd });
    const rejection = expect(running).rejects.toBeInstanceOf(TurnInterruptedError);

    await vi.waitFor(() => expect(playbackCallbacks).toBeDefined());
    expect(orchestrator.interrupt()).toBe(true);
    playbackCallbacks?.onStart?.();
    playbackCallbacks?.onProgress?.({
      currentTime: 1,
      duration: 2,
      progress: 0.5,
      audioLevel: 0.4,
      rms: 0.1
    });
    playbackCallbacks?.onEnded?.();

    await rejection;
    expect(speechPlayer.stop).toHaveBeenCalled();
    expect(onAudioStart).not.toHaveBeenCalled();
    expect(onAudioProgress).not.toHaveBeenCalled();
    expect(onAudioEnd).not.toHaveBeenCalled();
  });

  it("defensively normalizes untrusted reply fields", () => {
    const normalized = normalizeAgentReply({
      reply: "  你好  ",
      emotion: "angry",
      action: 42,
      ttsInstruction: null,
      memorySummary: 123,
      messagesCompacted: "true",
      performance: {
        schemaVersion: 2,
        turnId: "unsafe turn id",
        affect: { primary: "angry", intensity: 99 },
        defaultGaze: "behind",
        cues: "not-an-array"
      }
    }, "turn-safe");

    expect(normalized).toMatchObject({
      reply: "你好",
      emotion: "neutral",
      action: "idle",
      memorySummary: "",
      messagesCompacted: false,
      performance: {
        schemaVersion: 2,
        turnId: "turn-safe",
        reply: "你好",
        affect: { primary: "neutral" },
        cues: []
      }
    });
  });
});
