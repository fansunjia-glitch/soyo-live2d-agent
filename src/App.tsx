import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from "react";
import {
  Activity,
  Brain,
  Camera,
  CheckCircle2,
  Clock3,
  Coffee,
  Headphones,
  History,
  Layers3,
  Mic,
  MicOff,
  Music2,
  NotebookPen,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings,
  SlidersHorizontal,
  Smartphone,
  Trash2,
  Umbrella,
  UserRound,
  Volume2,
  X
} from "lucide-react";
import {
  agentAuthenticationRequiredEvent,
  agentFetch,
  apiUrl,
  getAgentAccessToken,
  setAgentAccessToken,
  wsUrl
} from "./api";
import { startVoiceCapture, type VoiceCapture } from "./audio";
import { SpeechPlayer } from "./audio/SpeechPlayer";
import {
  ConversationOrchestrator,
  TurnInterruptedError,
  type ConversationPhase
} from "./conversation/ConversationOrchestrator";
import { mergeTurnMessages } from "./conversation/messageMerge";
import { preparePhoto, type PreparedPhoto } from "./image";
import { DeviceBridge } from "./device-control/DeviceBridge";
import type { DeviceBridgeSnapshot } from "./device-control/types";
import type {
  GazeDirection,
  Live2DCapabilityReport,
  Live2DInteraction,
  RenderQuality,
  StagePreset
} from "./live2d/types";
import { SOYO_RIG_PROFILE } from "./live2d/soyoRigProfile";
import {
  fallbackPerformancePlan,
  type CuePriority,
  type PerformanceCue,
  type PerformancePlan
} from "./performance/types";
import { PerformanceTimeline } from "./performance/timeline";
import { PerformanceCueMixer, priorityRank } from "./performance/cueMixer";
import { authorizeStageSelection, SOYO_RIG_ID, SOYO_STAGE_MANIFEST } from "./resources";
import {
  applyRelationshipMemoryPatch,
  createRelationshipMemory,
  hydrateRelationshipMemory,
  inspectRelationshipMemory,
  mergeAgentRelationshipMemory,
  resetRelationshipMemory,
  type RelationshipMemory
} from "./memory/relationshipMemory";
import { PerceptionGate, type AcceptedPerceptionEvent } from "./perception/PerceptionGate";
import type { AgentAction, AgentEmotion, AgentReply, ChatMessage, RuntimeConfig } from "./types";

type AsrMessage =
  | { type: "asr-status"; status: string }
  | { type: "asr-error"; error: string }
  | { type: "asr-result"; text: string; final: boolean };

type Phase = ConversationPhase;
type View = "history" | "memory" | "models" | "voice" | "character";
type VoiceMode = "auto" | "soft" | "natural" | "default" | "custom";
type StageTheme = "atrium" | "night" | "studio" | "transparent";

type ChatSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  memorySummary: string;
  memorySummaries: MemorySummaryEntry[];
  relationshipMemory: RelationshipMemory;
};

type MemorySummaryEntry = {
  content: string;
  createdAt: number;
};

type AgentSettings = {
  llmModel: string;
  temperature: number;
  asrModel: string;
  ttsModel: string;
  voiceMode: VoiceMode;
  customVoice: string;
  live2dModelPath: string;
  stagePreset: StagePreset;
  stageTheme: StageTheme;
  renderQuality: RenderQuality;
  interactionEnabled: boolean;
  perceptionEnabled: boolean;
  perceptionFrameEscalation: boolean;
};

type SyncedReply = {
  sessionId: string;
  fullText: string;
  visibleText: string;
};

type SendToAgentOptions = {
  allowRelationshipMemoryPatch?: boolean;
};

const settingsKey = "soyo.agent.settings.v3";
let sessionBootstrapPromise: Promise<ChatSession[]> | null = null;
const Live2DStage = lazy(async () => {
  const module = await import("./live2d/Live2DStage");
  return { default: module.Live2DStage };
});

const initialConfig: RuntimeConfig = {
  llmModel: "qwen3.6-flash",
  asrModel: "paraformer-realtime-v2",
  ttsModel: "cosyvoice-v3.5-flash",
  ttsVoice: "longxiaochun",
  ttsVoices: {
    soft: "longxiaochun",
    natural: "longxiaochun"
  },
  voiceClone: {
    configured: false,
    defaultVoice: true,
    voiceId: "longxiaochun"
  },
  live2dModelPath: "/models/soyo/bestdori/model.json",
  ready: false
};

const initialSettings: AgentSettings = {
  llmModel: initialConfig.llmModel,
  temperature: 0.75,
  asrModel: initialConfig.asrModel,
  ttsModel: initialConfig.ttsModel,
  voiceMode: "auto",
  customVoice: "",
  live2dModelPath: initialConfig.live2dModelPath,
  stagePreset: "portrait",
  stageTheme: "atrium",
  renderQuality: "auto",
  interactionEnabled: true,
  perceptionEnabled: false,
  perceptionFrameEscalation: false
};

export default function App() {
  const [config, setConfig] = useState(initialConfig);
  const [settings, setSettings] = useState(() => readSettings());
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [draft, setDraft] = useState("");
  const [pendingPhoto, setPendingPhoto] = useState<PreparedPhoto | null>(null);
  const [transcript, setTranscript] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("未连接");
  const [emotion, setEmotion] = useState<AgentEmotion>("neutral");
  const [action, setAction] = useState<AgentAction>("idle");
  const [voiceTestStatus, setVoiceTestStatus] = useState("");
  const [view, setView] = useState<View>("history");
  const [sessionQuery, setSessionQuery] = useState("");
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [chatVisible, setChatVisible] = useState(true);
  const [chatRevealCount, setChatRevealCount] = useState(0);
  const [syncedReply, setSyncedReply] = useState<SyncedReply | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [inputLevel, setInputLevel] = useState(0);
  const [cueNonce, setCueNonce] = useState(0);
  const [gaze, setGaze] = useState<GazeDirection>("auto");
  const [performancePlan, setPerformancePlan] = useState<PerformancePlan | null>(null);
  const [activeScene, setActiveScene] = useState("default");
  const [activeProp, setActiveProp] = useState("");
  const [cueIntensity, setCueIntensity] = useState(1);
  const [cuePriority, setCuePriority] = useState<PerformanceCue["priority"]>("state");
  const [gestureCueId, setGestureCueId] = useState("base-gesture");
  const [expressionCueId, setExpressionCueId] = useState("base-expression");
  const [gazeCueId, setGazeCueId] = useState("base-gaze");
  const [gestureCueMeta, setGestureCueMeta] = useState<{ intensity: number; priority: CuePriority }>({ intensity: 1, priority: "state" });
  const [expressionCueMeta, setExpressionCueMeta] = useState<{ intensity: number; priority: CuePriority }>({ intensity: 0.65, priority: "state" });
  const [gazeCueMeta, setGazeCueMeta] = useState<{ intensity: number; priority: CuePriority }>({ intensity: 1, priority: "state" });
  const [live2dCapabilities, setLive2dCapabilities] = useState<Live2DCapabilityReport | null>(null);
  const [lastInteraction, setLastInteraction] = useState<Live2DInteraction | null>(null);
  const [live2dError, setLive2dError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authTokenDraft, setAuthTokenDraft] = useState(() => getAgentAccessToken());
  const [deviceBridge] = useState(() => new DeviceBridge());
  const [deviceSnapshot, setDeviceSnapshot] = useState<DeviceBridgeSnapshot>(() => deviceBridge.snapshot);
  const [perceptionGate] = useState(() => new PerceptionGate({
    rules: {
      "content.inspect": { maxGapMs: 2_000, minStableMs: 1_200 }
    }
  }));
  const [orchestrator] = useState(() => new ConversationOrchestrator());
  const [voicePreviewPlayer] = useState(() => new SpeechPlayer());
  const wsRef = useRef<WebSocket | null>(null);
  const captureRef = useRef<VoiceCapture | null>(null);
  const listeningAttemptRef = useRef(0);
  const lastFinalRef = useRef("");
  const latestTranscriptRef = useRef("");
  const asrFinishTimerRef = useRef<number | null>(null);
  const sendToAgentRef = useRef<((text: string, imageDataUrl?: string, options?: SendToAgentOptions) => Promise<void>) | null>(null);
  const performanceTimelineRef = useRef<PerformanceTimeline | null>(null);
  const performanceOwnerRef = useRef<string | null>(null);
  const performanceCueMixerRef = useRef(new PerformanceCueMixer());
  const performanceCueTimerRef = useRef<number | null>(null);
  const renderPerformanceCuesRef = useRef<(() => void) | null>(null);
  const baseEmotionRef = useRef<AgentEmotion>("neutral");
  const baseGazeRef = useRef<GazeDirection>("auto");
  const baseIntensityRef = useRef(0.65);
  const pendingPerformanceReplyRef = useRef<AgentReply | null>(null);
  const pendingPerformancePlanRef = useRef<PerformancePlan | null>(null);
  const lastSpeechProgressRef = useRef({ currentTime: 0, duration: 0 });
  const persistQueuesRef = useRef(new Map<string, Promise<void>>());
  const sessionsLoadAttemptRef = useRef(0);
  const voicePreviewAbortRef = useRef<AbortController | null>(null);
  const voicePreviewGenerationRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  const interruptTurnRef = useRef<(message?: string) => boolean>(() => false);

  const cancelVoicePreview = useCallback(() => {
    voicePreviewGenerationRef.current += 1;
    voicePreviewAbortRef.current?.abort();
    voicePreviewAbortRef.current = null;
    voicePreviewPlayer.stop();
  }, [voicePreviewPlayer]);

  useEffect(() => {
    void fetch(apiUrl("/api/config"))
      .then((response) => response.json())
      .then((nextConfig: RuntimeConfig) => {
        setConfig(nextConfig);
        setAuthRequired(Boolean(nextConfig.agentAuthRequired));
        if (nextConfig.agentAuthRequired && !getAgentAccessToken()) setAuthOpen(true);
        setSettings((current) => hydrateSettings(current, nextConfig));
        setStatus(nextConfig.agentAuthConfigured === false
          ? "服务端缺少 AGENT_ACCESS_TOKEN"
          : nextConfig.ready ? "云端模型已就绪" : "等待配置密钥");
      })
      .catch(() => {
        setStatus("后端未连接");
        setPhase("error");
      });
  }, []);

  useEffect(() => {
    localStorage.setItem(settingsKey, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => () => {
    void orchestrator.dispose();
    void voicePreviewPlayer.dispose();
  }, [orchestrator, voicePreviewPlayer]);

  useEffect(() => {
    const requestAuthentication = () => setAuthOpen(true);
    window.addEventListener(agentAuthenticationRequiredEvent, requestAuthentication);
    return () => window.removeEventListener(agentAuthenticationRequiredEvent, requestAuthentication);
  }, []);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    deviceBridge.onState = setDeviceSnapshot;
    if (config.deviceControlEnabled) deviceBridge.connect();
    else deviceBridge.disconnect();
    return () => {
      deviceBridge.onState = undefined;
      deviceBridge.disconnect();
    };
  }, [config.deviceControlEnabled, deviceBridge]);

  useEffect(() => {
    perceptionGate.setPermissions({
      enabled: settings.perceptionEnabled,
      allowedSources: settings.perceptionEnabled ? ["iphone-screen", "iphone-camera"] : [],
      allowFrameEscalation: settings.perceptionFrameEscalation
    });
    if (!settings.perceptionEnabled) perceptionGate.reset();
  }, [perceptionGate, settings.perceptionEnabled, settings.perceptionFrameEscalation]);

  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    const setViewportVars = () => {
      const visualHeight = viewport?.height ?? window.innerHeight;
      const keyboardInset = Math.max(0, window.innerHeight - visualHeight - (viewport?.offsetTop ?? 0));
      root.style.setProperty("--visual-height", `${visualHeight}px`);
      root.style.setProperty("--keyboard-inset", `${keyboardInset}px`);
      setKeyboardOpen(keyboardInset > 80);
      window.scrollTo(0, 0);
    };

    setViewportVars();
    window.addEventListener("resize", setViewportVars);
    window.addEventListener("orientationchange", setViewportVars);
    viewport?.addEventListener("resize", setViewportVars);
    viewport?.addEventListener("scroll", setViewportVars);
    return () => {
      window.removeEventListener("resize", setViewportVars);
      window.removeEventListener("orientationchange", setViewportVars);
      viewport?.removeEventListener("resize", setViewportVars);
      viewport?.removeEventListener("scroll", setViewportVars);
    };
  }, []);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? sessions[0],
    [activeSessionId, sessions]
  );
  const messages = useMemo(() => activeSession?.messages ?? [], [activeSession]);
  const displayedMessages = useMemo(() => {
    if (!syncedReply || syncedReply.sessionId !== activeSession?.id) {
      return messages;
    }
    const lastMessage = messages.at(-1);
    if (lastMessage?.role === "assistant" && lastMessage.content === syncedReply.fullText) {
      return syncedReply.visibleText
        ? [...messages.slice(0, -1), { role: "assistant", content: syncedReply.visibleText } satisfies ChatMessage]
        : messages.slice(0, -1);
    }
    return syncedReply.visibleText
      ? [...messages, { role: "assistant", content: syncedReply.visibleText } satisfies ChatMessage]
      : messages;
  }, [activeSession?.id, messages, syncedReply]);
  const latestMessageKey = messages.length > 0
    ? `${activeSession?.id ?? ""}:${messages.length}:${messages[messages.length - 1].role}:${messages[messages.length - 1].content}`
    : activeSession?.id ?? "";

  useEffect(() => {
    setChatVisible(true);
    if (consoleOpen || phase !== "idle" || transcript.trim()) {
      return;
    }

    const timeout = window.setTimeout(() => setChatVisible(false), 6500);
    return () => window.clearTimeout(timeout);
  }, [chatRevealCount, consoleOpen, latestMessageKey, phase, transcript]);

  const loadSessions = useCallback(async () => {
    const attempt = ++sessionsLoadAttemptRef.current;
    try {
      const nextSessions = await bootstrapSessions();
      if (sessionsLoadAttemptRef.current !== attempt) return;
      setSessions(nextSessions);
      setActiveSessionId((current) => nextSessions.some((session) => session.id === current) ? current : nextSessions[0].id);
    } catch (error) {
      if (sessionsLoadAttemptRef.current !== attempt) return;
      const fallback = createSession();
      setSessions([fallback]);
      setActiveSessionId(fallback.id);
      setStatus(error instanceof Error ? `历史记录未连接：${error.message}` : "历史记录未连接");
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const persistSession = useCallback(async (session: ChatSession) => {
    const previous = persistQueuesRef.current.get(session.id) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(async () => {
      const response = await agentFetch(apiUrl(`/api/sessions/${session.id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: session.title,
          messages: session.messages,
          memorySummary: session.memorySummary,
          memorySummaries: session.memorySummaries,
          relationshipMemory: session.relationshipMemory
        })
      });
      if (!response.ok) throw new Error(await response.text());
    });
    persistQueuesRef.current.set(session.id, pending);
    try {
      await pending;
    } catch (error) {
      setStatus(error instanceof Error ? `历史记录保存失败：${error.message}` : "历史记录保存失败");
    } finally {
      if (persistQueuesRef.current.get(session.id) === pending) {
        persistQueuesRef.current.delete(session.id);
      }
    }
  }, []);

  const updateActiveSession = useCallback((updater: (session: ChatSession) => ChatSession) => {
    setSessions((current) => current.map((session) => (
      session.id === activeSessionId ? persistAndReturn(updater(session), persistSession) : session
    )));
  }, [activeSessionId, persistSession]);

  const createNewSession = useCallback(() => {
    interruptTurnRef.current("已切换到新会话");
    void (async () => {
      try {
        const response = await agentFetch(apiUrl("/api/sessions"), { method: "POST" });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const session = hydrateChatSession(await response.json());
        setSessions((current) => [session, ...current]);
        setActiveSessionId(session.id);
        setSyncedReply(null);
        setPendingPhoto(null);
        setDraft("");
        setTranscript("");
        setEmotion("neutral");
        setAction("idle");
        setGaze("auto");
        setAudioLevel(0);
        setPerformancePlan(null);
        performanceTimelineRef.current = null;
        setPhase("idle");
        setStatus(config.ready ? "云端模型已就绪" : "等待配置密钥");
        setConsoleOpen(false);
      } catch (error) {
        setStatus(error instanceof Error ? `新建会话失败：${error.message}` : "新建会话失败");
      }
    })();
  }, [config.ready]);

  const deleteSession = useCallback((sessionId: string) => {
    if (sessionId === activeSessionId) interruptTurnRef.current("已删除当前会话");
    void (async () => {
      try {
        const response = await agentFetch(apiUrl(`/api/sessions/${sessionId}`), { method: "DELETE" });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        setSessions((current) => {
          const next = current.filter((session) => session.id !== sessionId);
          if (next.length > 0) {
            setActiveSessionId((currentId) => currentId === sessionId ? next[0].id : currentId);
            return next;
          }
          void loadSessions();
          return [];
        });
      } catch (error) {
        setStatus(error instanceof Error ? `删除会话失败：${error.message}` : "删除会话失败");
      }
    })();
  }, [activeSessionId, loadSessions]);

  const cancelListening = useCallback(() => {
    listeningAttemptRef.current += 1;
    if (asrFinishTimerRef.current !== null) window.clearTimeout(asrFinishTimerRef.current);
    asrFinishTimerRef.current = null;
    captureRef.current?.stop();
    captureRef.current = null;
    const socket = wsRef.current;
    wsRef.current = null;
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "stop" }));
      } catch {
        // Closing the socket below is the authoritative cleanup path.
      }
    }
    socket?.close();
    setInputLevel(0);
    setPhase((current) => current === "listening" ? "idle" : current);
  }, []);

  useEffect(() => {
    const stopMedia = () => {
      cancelListening();
      interruptTurnRef.current("页面已离开");
      cancelVoicePreview();
      deviceBridge.disconnect();
    };
    const resumeDeviceBridge = () => {
      if (config.deviceControlEnabled) deviceBridge.connect();
    };
    window.addEventListener("pagehide", stopMedia);
    window.addEventListener("pageshow", resumeDeviceBridge);
    return () => {
      window.removeEventListener("pagehide", stopMedia);
      window.removeEventListener("pageshow", resumeDeviceBridge);
      stopMedia();
    };
  }, [cancelListening, cancelVoicePreview, config.deviceControlEnabled, deviceBridge]);

  const finishListening = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;
    setInputLevel(0);
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      cancelListening();
      return;
    }
    try {
      socket.send(JSON.stringify({ type: "stop" }));
      setStatus("正在整理尾句");
    } catch {
      cancelListening();
      return;
    }
    if (asrFinishTimerRef.current !== null) window.clearTimeout(asrFinishTimerRef.current);
    asrFinishTimerRef.current = window.setTimeout(() => {
      const text = latestTranscriptRef.current.trim();
      cancelListening();
      if (text && text !== lastFinalRef.current) {
        lastFinalRef.current = text;
        void sendToAgentRef.current?.(text);
      }
    }, 3_000);
  }, [cancelListening]);

  const resolveVoice = useCallback((replyEmotion?: AgentEmotion) => {
    if (settings.voiceMode === "soft") return config.ttsVoices.soft;
    if (settings.voiceMode === "natural") return config.ttsVoices.natural;
    if (settings.voiceMode === "default") return config.ttsVoice;
    if (settings.voiceMode === "custom") return settings.customVoice.trim() || undefined;
    return replyEmotion ? undefined : config.ttsVoices.soft;
  }, [config.ttsVoice, config.ttsVoices.natural, config.ttsVoices.soft, settings.customVoice, settings.voiceMode]);

  const renderPerformanceCues = useCallback(() => {
    const now = performance.now();
    const snapshot = performanceCueMixerRef.current.snapshot(now);
    let sceneId = snapshot.scene?.resourceId ?? "default";
    let propId = snapshot.prop?.resourceId ?? "";
    if (!isBuiltInSoyoModel(settings.live2dModelPath)) propId = "";
    let authorization = authorizeStageSelection(SOYO_STAGE_MANIFEST, {
      sceneId,
      rigId: SOYO_RIG_ID,
      propIds: propId ? [propId] : []
    });
    if (!authorization.ok && propId) {
      propId = "";
      authorization = authorizeStageSelection(SOYO_STAGE_MANIFEST, {
        sceneId,
        rigId: SOYO_RIG_ID,
        propIds: []
      });
    }
    if (!authorization.ok) {
      sceneId = "default";
      propId = "";
    }

    setAction(snapshot.gesture?.action ?? "idle");
    setEmotion(snapshot.expression?.emotion ?? baseEmotionRef.current);
    setGaze(snapshot.gaze?.gaze ?? baseGazeRef.current);
    setGestureCueId(snapshot.gesture?.cueId ?? "base-gesture");
    setExpressionCueId(snapshot.expression?.cueId ?? "base-expression");
    setGazeCueId(snapshot.gaze?.cueId ?? "base-gaze");
    setGestureCueMeta({
      intensity: snapshot.gesture?.intensity ?? 1,
      priority: snapshot.gesture?.priority ?? "state"
    });
    setExpressionCueMeta({
      intensity: snapshot.expression?.intensity ?? baseIntensityRef.current,
      priority: snapshot.expression?.priority ?? "state"
    });
    setGazeCueMeta({
      intensity: snapshot.gaze?.intensity ?? 1,
      priority: snapshot.gaze?.priority ?? "state"
    });
    setActiveScene(sceneId);
    setActiveProp(propId);
    const winners = Object.values(snapshot).filter((cue): cue is PerformanceCue => Boolean(cue));
    const leading = winners.reduce<PerformanceCue | undefined>((current, cue) => (
      !current || priorityRank(cue.priority) >= priorityRank(current.priority) ? cue : current
    ), undefined);
    setCueIntensity(leading?.intensity ?? baseIntensityRef.current);
    setCuePriority(leading?.priority ?? "state");

    if (performanceCueTimerRef.current !== null) window.clearTimeout(performanceCueTimerRef.current);
    const nextExpiry = performanceCueMixerRef.current.nextExpiry(now);
    performanceCueTimerRef.current = nextExpiry === undefined ? null : window.setTimeout(() => {
      performanceCueTimerRef.current = null;
      renderPerformanceCuesRef.current?.();
    }, Math.max(0, nextExpiry - performance.now()) + 1);
  }, [settings.live2dModelPath]);
  renderPerformanceCuesRef.current = renderPerformanceCues;

  const clearPerformanceCues = useCallback((owner = performanceOwnerRef.current) => {
    if (owner) performanceCueMixerRef.current.clear(owner);
    if (owner && performanceOwnerRef.current === owner) performanceOwnerRef.current = null;
    renderPerformanceCues();
  }, [renderPerformanceCues]);

  const applyPerformanceCue = useCallback((cue: PerformanceCue, owner = performanceOwnerRef.current ?? "local") => {
    performanceCueMixerRef.current.add(cue, performance.now(), owner);
    renderPerformanceCues();
  }, [renderPerformanceCues]);

  useEffect(() => {
    const owner = "phase";
    performanceCueMixerRef.current.clear(owner);
    const phaseCue: { action?: AgentAction; emotion?: AgentEmotion; gaze?: GazeDirection | { x: number; y: number } } = SOYO_RIG_PROFILE.phases[phase];
    const now = performance.now();
    if (phaseCue.action) {
      performanceCueMixerRef.current.add({
        cueId: `phase:${phase}:gesture`,
        channel: "gesture",
        anchor: { kind: "time", atMs: 0 },
        action: phaseCue.action,
        intensity: 0.72,
        priority: "state"
      }, now, owner);
    }
    if (phaseCue.emotion) {
      performanceCueMixerRef.current.add({
        cueId: `phase:${phase}:expression`,
        channel: "expression",
        anchor: { kind: "time", atMs: 0 },
        emotion: phaseCue.emotion,
        intensity: 0.62,
        priority: "state"
      }, now, owner);
    }
    if (phaseCue.gaze) {
      const semanticGaze = typeof phaseCue.gaze === "string" ? phaseCue.gaze : phase === "thinking" ? "left" : "user";
      performanceCueMixerRef.current.add({
        cueId: `phase:${phase}:gaze`,
        channel: "gaze",
        anchor: { kind: "time", atMs: 0 },
        gaze: semanticGaze,
        intensity: 0.72,
        priority: "state"
      }, now, owner);
    }
    renderPerformanceCues();
  }, [phase, renderPerformanceCues]);

  useEffect(() => () => {
    if (performanceCueTimerRef.current !== null) window.clearTimeout(performanceCueTimerRef.current);
  }, []);

  const interruptTurn = useCallback((message = "已打断") => {
    const interrupted = orchestrator.interrupt(message);
    cancelVoicePreview();
    pendingPerformanceReplyRef.current = null;
    pendingPerformancePlanRef.current = null;
    setAudioLevel(0);
    setSyncedReply(null);
    baseEmotionRef.current = "neutral";
    baseGazeRef.current = "user";
    baseIntensityRef.current = 0.65;
    clearPerformanceCues();
    performanceTimelineRef.current = null;
    if (interrupted) {
      setPhase("interrupted");
      setStatus(message);
      setCueNonce((current) => current + 1);
    }
    return interrupted;
  }, [cancelVoicePreview, clearPerformanceCues, orchestrator]);
  interruptTurnRef.current = interruptTurn;

  const sendToAgent = useCallback(async (text: string, imageDataUrl?: string, options: SendToAgentOptions = {}) => {
    // This call begins synchronously when invoked by the submit gesture. On
    // iOS it unlocks Web Audio before LLM/TTS network waits consume activation.
    void orchestrator.resumeAudio().catch(() => undefined);
    const content = text.trim() || (imageDataUrl ? "请看看我刚拍到的画面。" : "");
    const session = activeSession;
    if (!content || !session) {
      return;
    }

    interruptTurn("开始新的对话");

    const userMessage: ChatMessage = {
      role: "user",
      content: imageDataUrl ? `[照片] ${content}` : content
    };
    const nextMessages: ChatMessage[] = [...session.messages, userMessage];
    updateActiveSession((current) => ({
      ...current,
      title: current.messages.length === 0 ? createTitle(content) : current.title,
      updatedAt: Date.now(),
      messages: nextMessages
    }));
    setDraft("");
    setTranscript("");
    setPhase("thinking");
    setStatus("思考中");
    setConsoleOpen(false);
    setActiveProp("");
    let pendingAssistantMessage: ChatMessage | null = null;
    let pendingMessagesCompacted = false;
    let pendingMemorySummary = session.memorySummary;
    let pendingMemorySummaries = session.memorySummaries;
    let pendingRelationshipPatch: unknown;
    let pendingRelationshipUpdatedAt = Date.now();
    let pendingRelationshipTurnId: string | undefined;
    let assistantCommitted = false;

    const commitAssistantMessage = () => {
      if (assistantCommitted || !pendingAssistantMessage) {
        return;
      }
      const assistantMessage = pendingAssistantMessage;
      assistantCommitted = true;
      updateActiveSession((current) => {
        const relationshipMemory = mergeAgentRelationshipMemory(
          current.relationshipMemory,
          pendingRelationshipPatch,
          pendingRelationshipUpdatedAt,
          pendingRelationshipTurnId
        );
        return {
          ...current,
          updatedAt: Date.now(),
          messages: mergeTurnMessages(current.messages, nextMessages, assistantMessage, pendingMessagesCompacted),
          memorySummary: pendingMemorySummary,
          memorySummaries: pendingMemorySummaries,
          relationshipMemory
        };
      });
    };

    try {
      await orchestrator.run({
        messages: nextMessages,
        memorySummary: session.memorySummary,
        imageDataUrl,
        llmModel: settings.llmModel,
        temperature: settings.temperature,
        ttsModel: settings.ttsModel,
        resolveVoice,
        deviceCapabilities: deviceSnapshot.authenticated && deviceSnapshot.deviceConnected
          ? deviceSnapshot.capabilities
          : [],
        resolveDeviceRequest: (request, signal) => deviceBridge.execute(request, signal),
        relationshipScopeId: session.id,
        relationshipContext: relationshipMemoryContext(session.relationshipMemory)
      }, {
        onPhase: setPhase,
        onStatus: setStatus,
        onReply: (agentReply) => {
          if (imageDataUrl) setPendingPhoto(null);
          pendingPerformanceReplyRef.current = agentReply;
          pendingAssistantMessage = { role: "assistant", content: agentReply.reply };
          pendingMessagesCompacted = agentReply.messagesCompacted;
          pendingMemorySummary = agentReply.memorySummary;
          if (agentReply.messagesCompacted && agentReply.memorySummary) {
            pendingMemorySummaries = [
              ...session.memorySummaries,
              { content: agentReply.memorySummary, createdAt: Date.now() }
            ].slice(-10);
          }
          pendingRelationshipPatch = options.allowRelationshipMemoryPatch === false ? undefined : agentReply.memoryPatch;
          pendingRelationshipUpdatedAt = Date.now();
          pendingRelationshipTurnId = agentReply.performance?.turnId;
          const plan = validPerformancePlan(agentReply.performance)
            ? agentReply.performance
            : fallbackPerformancePlan(agentReply);
          performanceTimelineRef.current = new PerformanceTimeline(plan);
          pendingPerformancePlanRef.current = plan;
          lastSpeechProgressRef.current = { currentTime: 0, duration: 0 };
          setPerformancePlan(plan);
          const previousOwner = performanceOwnerRef.current;
          if (previousOwner) performanceCueMixerRef.current.clear(previousOwner);
          performanceOwnerRef.current = plan.turnId;
          baseEmotionRef.current = plan.affect.primary;
          baseGazeRef.current = plan.defaultGaze;
          baseIntensityRef.current = plan.affect.intensity;
          setEmotion(plan.affect.primary);
          setCueIntensity(plan.affect.intensity);
          setGaze(plan.defaultGaze);
          // Persist the complete text as soon as the LLM returns. Speech may be
          // interrupted later; history and the next turn must still stay whole.
          commitAssistantMessage();
          setSyncedReply({ sessionId: session.id, fullText: agentReply.reply, visibleText: "" });
        },
        onAudioStart: () => {
          const agentReply = pendingPerformanceReplyRef.current;
          if (!agentReply) return;
          const replyCharacters = Array.from(agentReply.reply);
          setSyncedReply({
            sessionId: session.id,
            fullText: agentReply.reply,
            visibleText: replyCharacters.slice(0, 1).join("")
          });
          const plan = performanceTimelineRef.current;
          plan?.due(0, 0).forEach((cue) => applyPerformanceCue(cue));
        },
        onAudioProgress: (progress) => {
          const agentReply = pendingPerformanceReplyRef.current;
          if (!agentReply) return;
          const replyCharacters = Array.from(agentReply.reply);
          const estimatedDuration = Math.max(replyCharacters.length / 8, 1);
          const ratio = progress.duration > 0 ? progress.progress : Math.min(progress.currentTime / estimatedDuration, 1);
          const visibleLength = Math.max(1, Math.ceil(replyCharacters.length * ratio));
          setAudioLevel(progress.audioLevel);
          lastSpeechProgressRef.current = {
            currentTime: progress.currentTime,
            duration: progress.duration
          };
          setSyncedReply({
            sessionId: session.id,
            fullText: agentReply.reply,
            visibleText: replyCharacters.slice(0, visibleLength).join("")
          });
          performanceTimelineRef.current?.due(
            progress.currentTime,
            progress.duration > 0 ? progress.duration : 0
          ).forEach((cue) => applyPerformanceCue(cue));
        },
        onAudioEnd: () => {
          setAudioLevel(0);
          setSyncedReply(null);
          commitAssistantMessage();
          const now = performance.now();
          const progress = lastSpeechProgressRef.current;
          const finalDuration = progress.duration > 0
            ? progress.duration
            : Math.max(Array.from(pendingPerformancePlanRef.current?.reply ?? "").length, 8) / 8;
          const remainingEndCues = performanceTimelineRef.current
            ?.due(finalDuration, finalDuration)
            .filter((cue) => cue.anchor.kind === "speech" && cue.anchor.event === "end") ?? [];
          const owner = performanceOwnerRef.current;
          if (owner) performanceCueMixerRef.current.retainOwner(
            owner,
            (cue) => cue.anchor.kind === "speech" && cue.anchor.event === "end",
            now,
            1_200
          );
          remainingEndCues.forEach((cue) => performanceCueMixerRef.current.add({
              ...cue,
              durationMs: cue.durationMs ?? 1_200
            }, now, owner ?? "post-speech"));
          renderPerformanceCues();
          pendingPerformanceReplyRef.current = null;
          pendingPerformancePlanRef.current = null;
          performanceTimelineRef.current = null;
        }
      });
    } catch (error) {
      if (error instanceof TurnInterruptedError) {
        commitAssistantMessage();
        return;
      }
      setAudioLevel(0);
      setSyncedReply(null);
      commitAssistantMessage();
      pendingPerformanceReplyRef.current = null;
      pendingPerformancePlanRef.current = null;
      performanceTimelineRef.current = null;
      clearPerformanceCues();
      setPhase("error");
      const message = error instanceof Error ? error.message : "请求失败";
      setStatus(pendingAssistantMessage ? `${message} · 已显示文字回复` : message);
    }
  }, [
    activeSession,
    applyPerformanceCue,
    clearPerformanceCues,
    deviceBridge,
    deviceSnapshot.authenticated,
    deviceSnapshot.capabilities,
    deviceSnapshot.deviceConnected,
    interruptTurn,
    orchestrator,
    renderPerformanceCues,
    resolveVoice,
    settings.llmModel,
    settings.temperature,
    settings.ttsModel,
    updateActiveSession
  ]);
  sendToAgentRef.current = sendToAgent;

  const applyPerceptionEvent = useCallback((event: AcceptedPerceptionEvent) => {
    if (event.route === "local" && event.localReaction) {
      const owner = event.eventId;
      applyPerformanceCue({
        cueId: `${owner}:gesture`,
        channel: "gesture",
        anchor: { kind: "time", atMs: 0 },
        action: event.localReaction.action,
        intensity: Math.max(0.45, event.confidence),
        priority: "interaction",
        durationMs: 1_600
      }, owner);
      applyPerformanceCue({
        cueId: `${owner}:expression`,
        channel: "expression",
        anchor: { kind: "time", atMs: 0 },
        emotion: event.localReaction.emotion,
        intensity: Math.max(0.45, event.confidence),
        priority: "interaction",
        durationMs: 2_000
      }, owner);
      applyPerformanceCue({
        cueId: `${owner}:gaze`,
        channel: "gaze",
        anchor: { kind: "time", atMs: 0 },
        gaze: event.localReaction.gaze,
        intensity: 0.8,
        priority: "interaction",
        durationMs: 1_800
      }, owner);
      if (phaseRef.current === "idle") setStatus(`本地感知 · ${perceptionLabel(event.kind)}`);
      return;
    }
    const frame = event.frameForImmediateInference;
    if (!frame || phaseRef.current !== "idle") return;
    // The frame remains request-scoped: sendToAgent stores only the textual
    // placeholder in history and never copies the frame into React state.
    void sendToAgentRef.current?.(
      "请结合当前 iPhone 画面，主动告诉我最值得注意的一件事。",
      frame.dataUrl,
      { allowRelationshipMemoryPatch: false }
    );
  }, [applyPerformanceCue]);

  useEffect(() => {
    const accept = (value: unknown, now = Date.now()) => {
      const decision = perceptionGate.ingest(value, now);
      if (decision.status === "accepted") applyPerceptionEvent(decision.event);
    };
    deviceBridge.onPerceptionSignal = (signal) => accept(signal);
    deviceBridge.onScreenFrame = (dataUrl) => {
      if (!dataUrl || phaseRef.current !== "idle") return;
      const observedAt = Date.now();
      accept({
        source: "iphone-screen",
        kind: "content.inspect",
        confidence: 0.95,
        observedAt,
        subjectId: "active-screen",
        label: "live-screen",
        frame: { dataUrl, capturedAt: observedAt }
      }, observedAt);
    };
    deviceBridge.onApproval = ({ action: approvedAction, required, ok }) => {
      if (required) setStatus(`等待 iPhone 授权 · ${approvedAction}`);
      else if (ok === false) setStatus(`iPhone 已拒绝 · ${approvedAction}`);
    };
    return () => {
      deviceBridge.onPerceptionSignal = undefined;
      deviceBridge.onScreenFrame = undefined;
      deviceBridge.onApproval = undefined;
    };
  }, [applyPerceptionEvent, deviceBridge, perceptionGate]);

  const selectPhoto = useCallback(async (file: File) => {
    setStatus("处理照片");
    try {
      const photo = await preparePhoto(file);
      setPendingPhoto(photo);
      setChatVisible(true);
      setPhase("idle");
      setStatus("照片已就绪");
    } catch (error) {
      setPhase("error");
      setStatus(error instanceof Error ? error.message : "照片处理失败");
    }
  }, []);

  const testVoice = useCallback(async () => {
    interruptTurn("切换到音色试听");
    void voicePreviewPlayer.resume().catch(() => undefined);
    const generation = ++voicePreviewGenerationRef.current;
    const abortController = new AbortController();
    voicePreviewAbortRef.current?.abort();
    voicePreviewAbortRef.current = abortController;
    const isCurrent = () => voicePreviewGenerationRef.current === generation && !abortController.signal.aborted;
    setVoiceTestStatus("生成测试音频");
    setStatus("生成测试音频");
    setPhase("thinking");

    try {
      const response = await agentFetch(apiUrl("/api/tts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          text: "你好，我在这里。今天也请多指教。",
          instruction: "语气温柔、自然、稍微克制。",
          emotion: "happy",
          model: settings.ttsModel,
          voice: resolveVoice("happy")
        })
      });
      if (!isCurrent()) return;

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const audioBlob = await response.blob();
      if (!isCurrent()) return;
      setVoiceTestStatus(response.headers.get("X-Soyo-TTS-Voice") ?? "播放测试音频");
      setEmotion("happy");
      setAction("nod");
      setCueNonce((current) => current + 1);
      await voicePreviewPlayer.play(audioBlob, {
        onStart: () => {
          if (!isCurrent()) return;
          setStatus("测试音色");
          setPhase("speaking");
        },
        onProgress: (progress) => {
          if (isCurrent()) setAudioLevel(progress.audioLevel);
        },
        onEnded: () => {
          if (!isCurrent()) return;
          voicePreviewAbortRef.current = null;
          setAudioLevel(0);
          setVoiceTestStatus("测试完成");
          setPhase("idle");
          setStatus("空闲");
          setAction("idle");
        },
        onError: (error) => {
          if (!isCurrent()) return;
          voicePreviewAbortRef.current = null;
          setAudioLevel(0);
          setPhase("error");
          setStatus(error.message);
          setVoiceTestStatus(error.message);
        }
      });
    } catch (error) {
      if (!isCurrent() || (error instanceof DOMException && error.name === "AbortError")) return;
      voicePreviewAbortRef.current = null;
      setPhase("error");
      const message = error instanceof Error ? error.message : "音色测试失败";
      setStatus(message);
      setVoiceTestStatus(message);
    }
  }, [interruptTurn, resolveVoice, settings.ttsModel, voicePreviewPlayer]);

  const startListening = useCallback(async () => {
    void orchestrator.resumeAudio().catch(() => undefined);
    if (authRequired && !getAgentAccessToken()) {
      setAuthOpen(true);
      setStatus("请输入访问口令");
      return;
    }
    if (phase === "listening") {
      finishListening();
      return;
    }

    if (["thinking", "buffering", "speaking"].includes(phase)) {
      interruptTurn("已打断，正在听");
    }

    setPhase("listening");
    setStatus("连接识别服务");
    setTranscript("");
    latestTranscriptRef.current = "";
    lastFinalRef.current = "";
    const attempt = ++listeningAttemptRef.current;

    const ws = new WebSocket(wsUrl(`/ws/asr?model=${encodeURIComponent(settings.asrModel)}`));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    const isCurrent = () => listeningAttemptRef.current === attempt && wsRef.current === ws;
    const failListening = (message: string) => {
      if (!isCurrent()) return;
      cancelListening();
      setPhase("error");
      setStatus(message);
    };

    ws.onopen = () => {
      void (async () => {
        try {
          if (!isCurrent()) return;
          if (authRequired) {
            ws.send(JSON.stringify({ type: "authenticate", token: getAgentAccessToken() }));
          }
          ws.send(JSON.stringify({ type: "start" }));
          const capture = await startVoiceCapture((chunk) => {
            if (isCurrent() && ws.readyState === WebSocket.OPEN) ws.send(chunk);
          }, (level) => {
            if (isCurrent()) setInputLevel(level);
          });
          if (!isCurrent() || ws.readyState !== WebSocket.OPEN) {
            capture.stop();
            return;
          }
          captureRef.current?.stop();
          captureRef.current = capture;
        } catch (error) {
          failListening(error instanceof Error ? error.message : "无法打开麦克风");
        }
      })();
    };

    ws.onmessage = (event) => {
      if (!isCurrent()) return;
      let message: AsrMessage;
      try {
        message = JSON.parse(event.data as string) as AsrMessage;
      } catch {
        failListening("识别服务返回了无效消息");
        return;
      }
      if (message.type === "asr-status") {
        if (message.status === "finished") {
          const text = latestTranscriptRef.current.trim();
          cancelListening();
          if (text && text !== lastFinalRef.current) {
            lastFinalRef.current = text;
            void sendToAgent(text);
          }
          return;
        }
        setStatus(message.status === "started" ? "正在听" : message.status);
        return;
      }
      if (message.type === "asr-error") {
        failListening(message.error);
        return;
      }
      if (message.type === "asr-result") {
        setTranscript(message.text);
        latestTranscriptRef.current = message.text;
        if (message.final && message.text.trim() && message.text !== lastFinalRef.current) {
          lastFinalRef.current = message.text;
          cancelListening();
          void sendToAgent(message.text);
        }
      }
    };

    ws.onerror = () => {
      failListening("语音连接失败");
    };
    ws.onclose = (event) => {
      if (event.code === 4401) setAuthOpen(true);
      if (isCurrent()) failListening(event.code === 4401 ? "访问口令无效" : "语音连接已关闭");
    };
  }, [authRequired, cancelListening, finishListening, interruptTurn, orchestrator, phase, sendToAgent, settings.asrModel]);

  useEffect(() => cancelListening, [cancelListening]);

  const statusTone = useMemo(() => {
    if (phase === "error") return "danger";
    if (phase === "listening") return "live";
    if (phase === "speaking") return "speaking";
    if (phase === "thinking" || phase === "buffering") return "thinking";
    if (phase === "interrupted") return "warning";
    return "idle";
  }, [phase]);

  const filteredSessions = useMemo(() => {
    const query = sessionQuery.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter((session) => {
      const text = `${session.title} ${session.messages.map((message) => message.content).join(" ")}`.toLowerCase();
      return text.includes(query);
    });
  }, [sessionQuery, sessions]);

  const voiceCloneLabel = useMemo(() => {
    if (config.voiceClone.soyoCloneFile?.matchesEnv) return "双音色已匹配";
    if (config.voiceClone.soyoCloneFile) return "双音色未启用";
    if (config.voiceClone.cloneFile && !config.voiceClone.cloneFile.matchesEnv) return "复刻结果未启用";
    if (config.voiceClone.cloneFile?.status && config.voiceClone.cloneFile.status !== "OK") {
      return `复刻状态 ${config.voiceClone.cloneFile.status}`;
    }
    return config.voiceClone.configured ? "复刻音色" : "默认音色";
  }, [config.voiceClone]);

  const saveServerDefaults = useCallback(() => {
    setSettings((current) => hydrateSettings({
      ...current,
      voiceMode: "auto",
      customVoice: ""
    }, config, true));
  }, [config]);

  const submitAgentAccessToken = useCallback(() => {
    setAgentAccessToken(authTokenDraft);
    sessionBootstrapPromise = null;
    setAuthOpen(false);
    setStatus("正在验证访问口令");
    void loadSessions();
  }, [authTokenDraft, loadSessions]);

  const saveRelationshipMemory = useCallback((memory: RelationshipMemory) => {
    updateActiveSession((session) => memory.scopeId === session.id
      ? { ...session, relationshipMemory: memory, updatedAt: Date.now() }
      : session);
  }, [updateActiveSession]);

  return (
    <main
      className={`soyoExperience theme-${settings.stageTheme} ${sceneClass(activeScene)} ${keyboardOpen ? "keyboardOpen" : ""}`}
      data-phase={phase}
      style={{ "--voice-level": String(phase === "listening" ? inputLevel : audioLevel) } as CSSProperties}
    >
      <div className="stageEnvironment" aria-hidden="true">
        <span className="ambientOrb orbOne" />
        <span className="ambientOrb orbTwo" />
        <span className="windowLight" />
      </div>
      <Suspense fallback={<div className="stageLoading" aria-live="polite">正在加载 Live2D…</div>}>
        <Live2DStage
          modelPath={settings.live2dModelPath}
          emotion={emotion}
          action={action}
          speaking={phase === "speaking"}
          keyboardOpen={keyboardOpen}
          phase={phase}
          audioLevel={audioLevel}
          cueNonce={cueNonce}
          cueIntensity={cueIntensity}
          cuePriority={cuePriority}
          gestureCueId={gestureCueId}
          expressionCueId={expressionCueId}
          gazeCueId={gazeCueId}
          gestureCueIntensity={gestureCueMeta.intensity}
          gestureCuePriority={gestureCueMeta.priority}
          expressionCueIntensity={expressionCueMeta.intensity}
          expressionCuePriority={expressionCueMeta.priority}
          gazeCueIntensity={gazeCueMeta.intensity}
          gazeCuePriority={gazeCueMeta.priority}
          gaze={gaze}
          stagePreset={settings.stagePreset}
          renderQuality={settings.renderQuality}
          interactionEnabled={settings.interactionEnabled}
          onCapabilities={(capabilities) => {
            setLive2dCapabilities(capabilities);
            setLive2dError("");
          }}
          onInteraction={(interaction) => {
            setLastInteraction(interaction);
            setChatVisible(true);
            if (phase === "idle") setStatus(interaction.hitAreas.length ? `互动 · ${interaction.hitAreas.join(" / ")}` : "互动 · 轻触");
            const cueId = `interaction:${createId()}`;
            if (interaction.cue?.action) {
              applyPerformanceCue({
                cueId: `${cueId}:gesture`,
                channel: "gesture",
                anchor: { kind: "time", atMs: 0 },
                action: interaction.cue.action,
                intensity: 1,
                priority: "interaction",
                durationMs: 1_600
              }, cueId);
            }
            if (interaction.cue?.emotion) {
              applyPerformanceCue({
                cueId: `${cueId}:expression`,
                channel: "expression",
                anchor: { kind: "time", atMs: 0 },
                emotion: interaction.cue.emotion,
                intensity: 0.8,
                priority: "interaction",
                durationMs: 2_000
              }, cueId);
            }
          }}
          onLoadError={(error) => setLive2dError(error.message)}
        />
      </Suspense>
      <div className="stageWash" />
      {activeProp ? (
        <>
          <StageProp propId={activeProp} sceneId={activeScene} modelPath={settings.live2dModelPath} />
          <div className="activeProp" aria-label={`当前道具 ${activeProp}`}><Layers3 size={14} />{activeProp}</div>
        </>
      ) : null}

      <header className="experienceTopbar">
        <div className={`statusPill ${statusTone}`}>
          <span />
          <strong>{status}</strong>
          <i className="voiceMeter" aria-hidden="true"><i /></i>
        </div>
        <div className="topbarActions">
          {settings.perceptionEnabled ? (
            <button
              className={`sensingBadge ${settings.perceptionFrameEscalation ? "vision" : ""}`}
              type="button"
              onClick={() => { setView("character"); setConsoleOpen(true); }}
              title="点击查看或关闭 iPhone 感知"
            >
              <Camera size={14} />
              <span>{settings.perceptionFrameEscalation ? "iPhone 视觉" : "iPhone 感知"}</span>
            </button>
          ) : null}
          {config.deviceControlEnabled ? (
            <a
              className={`settingsFab deviceLink ${deviceSnapshot.deviceConnected ? "connected" : ""}`}
              href="/device-control"
              title={`iPhone Agent · ${deviceConnectionLabel(deviceSnapshot)}`}
            >
              <Smartphone size={20} />
            </a>
          ) : null}
          <button className="settingsFab" type="button" onClick={() => setConsoleOpen(true)} title="设置">
            <Settings size={21} />
          </button>
        </div>
      </header>

      <StageChatDock
        messages={displayedMessages}
        draft={draft}
        phase={phase}
        transcript={transcript}
        sessionTitle={activeSession?.title ?? "实时语音对话"}
        conversationVisible={chatVisible}
        photo={pendingPhoto}
        onDraftChange={setDraft}
        onPhotoSelect={(file) => void selectPhoto(file)}
        onPhotoRemove={() => {
          setPendingPhoto(null);
          setStatus(config.ready ? "云端模型已就绪" : "等待配置密钥");
        }}
        onSubmit={() => void sendToAgent(draft, pendingPhoto?.dataUrl)}
        onListen={() => void startListening()}
        onRevealConversation={() => {
          setChatVisible(true);
          setChatRevealCount((count) => count + 1);
        }}
      />

      {consoleOpen ? (
        <ConsoleOverlay
          view={view}
          setView={setView}
          statusTone={statusTone}
          status={status}
          sessions={filteredSessions}
          memorySession={activeSession}
          onRelationshipMemoryChange={saveRelationshipMemory}
          activeSessionId={activeSession?.id ?? ""}
          sessionQuery={sessionQuery}
          setSessionQuery={setSessionQuery}
          createNewSession={createNewSession}
          selectSession={(sessionId) => {
            interruptTurn("已切换会话");
            setActiveSessionId(sessionId);
            setPendingPhoto(null);
            setPerformancePlan(null);
            setEmotion("neutral");
            setAction("idle");
            setGaze("auto");
            setConsoleOpen(false);
          }}
          deleteSession={deleteSession}
          config={config}
          deviceSnapshot={deviceSnapshot}
          settings={settings}
          setSettings={setSettings}
          saveServerDefaults={saveServerDefaults}
          voiceCloneLabel={voiceCloneLabel}
          voiceTestStatus={voiceTestStatus}
          phase={phase}
          testVoice={() => void testVoice()}
          emotion={emotion}
          action={action}
          performancePlan={performancePlan}
          capabilities={live2dCapabilities}
          lastInteraction={lastInteraction}
          live2dError={live2dError}
          onPreview={(nextEmotion, nextAction, nextGaze = "user") => {
            setEmotion(nextEmotion);
            setAction(nextAction);
            setGaze(nextGaze);
            setCueNonce((current) => current + 1);
          }}
          close={() => setConsoleOpen(false)}
        />
      ) : null}
      {authOpen ? (
        <AgentAccessOverlay
          required={authRequired}
          token={authTokenDraft}
          onTokenChange={setAuthTokenDraft}
          onSubmit={submitAgentAccessToken}
          onClose={() => {
            if (!authRequired) setAuthOpen(false);
          }}
        />
      ) : null}
    </main>
  );
}

function StageProp({ propId, sceneId, modelPath }: { propId: string; sceneId: string; modelPath: string }) {
  if (!isBuiltInSoyoModel(modelPath)) return null;
  const selection = authorizeStageSelection(SOYO_STAGE_MANIFEST, {
    sceneId,
    rigId: SOYO_RIG_ID,
    propIds: [propId]
  });
  if (!selection.ok || selection.value.props.length !== 1) return null;
  const binding = selection.value.props[0].binding;
  const graphic: Record<string, ReactNode> = {
    umbrella: <Umbrella />,
    tea: <Coffee />,
    notebook: <NotebookPen />,
    cello: <Music2 />
  };
  return (
    <div
      className={`stageProp prop-${propId}`}
      style={{
        left: `${binding.x * 100}%`,
        top: `${binding.y * 100}%`,
        zIndex: binding.zIndex,
        "--prop-scale": String(binding.scale)
      } as CSSProperties}
      aria-hidden="true"
    >
      <span>{graphic[propId]}</span>
    </div>
  );
}

function AgentAccessOverlay({
  required,
  token,
  onTokenChange,
  onSubmit,
  onClose
}: {
  required: boolean;
  token: string;
  onTokenChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <section className="agentAccessBackdrop" role="dialog" aria-modal="true" aria-labelledby="agent-access-title">
      <form
        className="agentAccessCard"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div>
          <p className="eyebrow">LOCAL AGENT SECURITY</p>
          <h2 id="agent-access-title">输入服务访问口令</h2>
          <p>口令只保存在当前标签页，用于保护对话、语音与会话记忆接口。</p>
        </div>
        <label className="field">
          <span>AGENT_ACCESS_TOKEN</span>
          <input
            autoFocus
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => onTokenChange(event.target.value)}
            placeholder="服务端配置的高强度口令"
          />
        </label>
        <div className="buttonRow">
          {!required ? <button type="button" className="secondaryButton" onClick={onClose}>取消</button> : null}
          <button type="submit" className="primaryAction" disabled={!token.trim()}>验证并继续</button>
        </div>
      </form>
    </section>
  );
}

function StageChatDock({
  messages,
  draft,
  phase,
  transcript,
  sessionTitle,
  conversationVisible,
  photo,
  onDraftChange,
  onPhotoSelect,
  onPhotoRemove,
  onSubmit,
  onListen,
  onRevealConversation
}: {
  messages: ChatMessage[];
  draft: string;
  phase: Phase;
  transcript: string;
  sessionTitle: string;
  conversationVisible: boolean;
  photo: PreparedPhoto | null;
  onDraftChange: (value: string) => void;
  onPhotoSelect: (file: File) => void;
  onPhotoRemove: () => void;
  onSubmit: () => void;
  onListen: () => void;
  onRevealConversation: () => void;
}) {
  const busy = phase === "thinking" || phase === "buffering" || phase === "speaking";
  const photoInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <section
      className={`bottomChatDock ${conversationVisible ? "showHistory" : "compact"}`}
      aria-label="chat"
      onPointerEnter={onRevealConversation}
      onFocusCapture={onRevealConversation}
    >
      <div className="chatEphemeral" aria-hidden={!conversationVisible}>
        <div className="dockHeader">
          <strong>{sessionTitle}</strong>
          <span>{messages.length} 条</span>
        </div>

        <section className="miniConversation" aria-label="conversation">
          {messages.length === 0 ? (
            <div className="miniEmpty">
              <Volume2 size={18} />
              <span>等你开口。</span>
            </div>
          ) : messages.map((message, index) => (
            <article className={`bubble ${message.role}`} key={`${message.role}-${index}`}>
              <span>{message.role === "user" ? "You" : "Soyo"}</span>
              <p>{message.content}</p>
            </article>
          ))}
        </section>

        <div className="transcript">
          <span>{transcript || " "}</span>
        </div>
      </div>

      <form className="composer" onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}>
        <button
          className={`micButton ${phase === "listening" ? "active" : ""}`}
          type="button"
          onClick={onListen}
          title={phase === "listening" ? "停止收音" : busy ? "打断并开始收音" : "开始收音"}
        >
          {phase === "listening" ? <MicOff size={22} /> : <Mic size={22} />}
        </button>
        <button
          className="cameraButton"
          type="button"
          onClick={() => photoInputRef.current?.click()}
          disabled={busy}
          title="拍照"
        >
          <Camera size={21} />
        </button>
        <input
          ref={photoInputRef}
          className="cameraInput"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onPhotoSelect(file);
          }}
        />
        <div className="composerInput">
          {photo ? (
            <div className="photoPreview">
              <img src={photo.dataUrl} alt="待发送照片" />
              <button type="button" onClick={onPhotoRemove} disabled={busy} title="移除照片">
                <X size={16} />
              </button>
            </div>
          ) : null}
          <textarea
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder={photo ? "问问 Soyo 看到了什么..." : "和 Soyo 说点什么..."}
            disabled={busy}
            rows={1}
          />
        </div>
        <button className="sendButton" type="submit" disabled={(!draft.trim() && !photo) || busy} title="发送">
          <Send size={20} />
        </button>
      </form>
    </section>
  );
}

function ConsoleOverlay({
  view,
  setView,
  statusTone,
  status,
  sessions,
  memorySession,
  onRelationshipMemoryChange,
  activeSessionId,
  sessionQuery,
  setSessionQuery,
  createNewSession,
  selectSession,
  deleteSession,
  config,
  deviceSnapshot,
  settings,
  setSettings,
  saveServerDefaults,
  voiceCloneLabel,
  voiceTestStatus,
  phase,
  testVoice,
  emotion,
  action,
  performancePlan,
  capabilities,
  lastInteraction,
  live2dError,
  onPreview,
  close
}: {
  view: View;
  setView: Dispatch<SetStateAction<View>>;
  statusTone: string;
  status: string;
  sessions: ChatSession[];
  memorySession?: ChatSession;
  onRelationshipMemoryChange: (memory: RelationshipMemory) => void;
  activeSessionId: string;
  sessionQuery: string;
  setSessionQuery: (value: string) => void;
  createNewSession: () => void;
  selectSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  config: RuntimeConfig;
  deviceSnapshot: DeviceBridgeSnapshot;
  settings: AgentSettings;
  setSettings: Dispatch<SetStateAction<AgentSettings>>;
  saveServerDefaults: () => void;
  voiceCloneLabel: string;
  voiceTestStatus: string;
  phase: Phase;
  testVoice: () => void;
  emotion: AgentEmotion;
  action: AgentAction;
  performancePlan: PerformancePlan | null;
  capabilities: Live2DCapabilityReport | null;
  lastInteraction: Live2DInteraction | null;
  live2dError: string;
  onPreview: (emotion: AgentEmotion, action: AgentAction, gaze?: GazeDirection) => void;
  close: () => void;
}) {
  return (
    <section className="consoleShell" aria-label="settings console">
      <section className="consoleMain">
        <header className="consoleHeader">
          <div>
            <p className="eyebrow">{viewLabel(view)}</p>
            <h1>{viewTitle(view)}</h1>
          </div>
          <div className={`statusPill ${statusTone}`}>
            <span />
            <strong>{status}</strong>
          </div>
        </header>

        {view === "history" ? (
          <HistoryView
            sessions={sessions}
            activeSessionId={activeSessionId}
            sessionQuery={sessionQuery}
            setSessionQuery={setSessionQuery}
            createNewSession={createNewSession}
            selectSession={selectSession}
            deleteSession={deleteSession}
          />
        ) : null}

        {view === "memory" ? (
          <MemoryView session={memorySession} onMemoryChange={onRelationshipMemoryChange} />
        ) : null}

        {view === "models" ? (
          <ModelsView
            config={config}
            deviceSnapshot={deviceSnapshot}
            settings={settings}
            setSettings={setSettings}
            onReset={saveServerDefaults}
          />
        ) : null}

        {view === "voice" ? (
          <VoiceView
            config={config}
            settings={settings}
            setSettings={setSettings}
            voiceCloneLabel={voiceCloneLabel}
            voiceTestStatus={voiceTestStatus}
            phase={phase}
            onTestVoice={testVoice}
          />
        ) : null}

        {view === "character" ? (
          <CharacterView
            config={config}
            settings={settings}
            setSettings={setSettings}
            emotion={emotion}
            action={action}
            performancePlan={performancePlan}
            capabilities={capabilities}
            lastInteraction={lastInteraction}
            live2dError={live2dError}
            onPreview={onPreview}
            onReset={() => setSettings((current) => ({ ...current, live2dModelPath: config.live2dModelPath }))}
          />
        ) : null}
      </section>

      <nav className="consoleTabs" aria-label="console tabs">
        <button className="closeTab" type="button" onClick={close} title="返回对话">
          <X size={21} />
        </button>
        <button className={view === "history" ? "active" : ""} type="button" onClick={() => setView("history")} title="历史">
          <History size={20} />
          <span>历史</span>
        </button>
        <button className={view === "memory" ? "active" : ""} type="button" onClick={() => setView("memory")} title="记忆">
          <Brain size={20} />
          <span>记忆</span>
        </button>
        <button className={view === "models" ? "active" : ""} type="button" onClick={() => setView("models")} title="模型">
          <SlidersHorizontal size={20} />
          <span>模型</span>
        </button>
        <button className={view === "voice" ? "active" : ""} type="button" onClick={() => setView("voice")} title="语音">
          <Headphones size={20} />
          <span>语音</span>
        </button>
        <button className={view === "character" ? "active" : ""} type="button" onClick={() => setView("character")} title="角色">
          <UserRound size={20} />
          <span>角色</span>
        </button>
      </nav>
    </section>
  );
}

function MemoryView({
  session,
  onMemoryChange
}: {
  session?: ChatSession;
  onMemoryChange: (memory: RelationshipMemory) => void;
}) {
  const summaries = [...(session?.memorySummaries ?? [])].reverse();
  const memory = session?.relationshipMemory;
  const inspected = memory ? inspectRelationshipMemory(memory) : undefined;
  const [preferredName, setPreferredName] = useState(memory?.profile.preferredName ?? "");
  const [boundaryTopic, setBoundaryTopic] = useState("");
  const [boundaryRule, setBoundaryRule] = useState("");
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    setPreferredName(memory?.profile.preferredName ?? "");
    setFeedback("");
  }, [memory?.profile.preferredName, memory?.scopeId]);

  const applyUserPatch = (patch: unknown) => {
    if (!memory) return;
    const result = applyRelationshipMemoryPatch(memory, patch, { actor: "user", now: Date.now() });
    if (!result.ok) {
      setFeedback(result.issues[0]?.message ?? "记忆更新失败");
      return;
    }
    onMemoryChange(result.value);
    setFeedback("已保存");
  };

  return (
    <section className="memoryConsole">
      <header className="memoryOverview">
        <strong>{session?.title ?? "当前会话"}</strong>
        <span>关系记忆 r{memory?.revision ?? 0} · {summaries.length}/10 次总结</span>
      </header>

      {memory ? (
        <section className="relationshipMemoryPanel" aria-label="relationship memory">
          <div className="relationshipMemoryEditor">
            <Field label="希望 Soyo 如何称呼你">
              <input
                value={preferredName}
                maxLength={40}
                onChange={(event) => setPreferredName(event.target.value)}
                placeholder="昵称（仅由你修改）"
              />
            </Field>
            <button
              className="secondaryButton"
              type="button"
              onClick={() => applyUserPatch({
                scopeId: memory.scopeId,
                preferredName: preferredName.trim() || null,
                preferences: [],
                facts: [],
                boundaries: []
              })}
            >保存称呼</button>
          </div>
          <div className="relationshipMemoryEditor boundaryEditor">
            <Field label="互动边界主题">
              <input value={boundaryTopic} maxLength={80} onChange={(event) => setBoundaryTopic(event.target.value)} placeholder="例如：公开分享" />
            </Field>
            <Field label="边界规则">
              <input value={boundaryRule} maxLength={160} onChange={(event) => setBoundaryRule(event.target.value)} placeholder="例如：发送前必须再次确认" />
            </Field>
            <button
              className="secondaryButton"
              type="button"
              disabled={!boundaryTopic.trim() || !boundaryRule.trim()}
              onClick={() => {
                applyUserPatch({
                  scopeId: memory.scopeId,
                  preferences: [],
                  facts: [],
                  boundaries: [{ operation: "upsert", topic: boundaryTopic, rule: boundaryRule }]
                });
                setBoundaryTopic("");
                setBoundaryRule("");
              }}
            >添加边界</button>
          </div>
          {feedback ? <div className="fieldHint">{feedback}</div> : null}
          <div className="relationshipMemoryGroups">
            <MemoryChips title="偏好" empty="尚未形成偏好" values={inspected?.preferences.map((item) => `${item.sentiment === "like" ? "喜欢" : "不喜欢"} · ${item.value}`) ?? []} />
            <MemoryChips title="事实" empty="尚未记录事实" values={inspected?.facts.map((item) => `${item.key}: ${item.value}`) ?? []} />
            <MemoryChips title="互动边界" empty="尚未设置边界" values={inspected?.boundaries.map((item) => `${item.topic}: ${item.rule}`) ?? []} />
          </div>
          <button
            className="secondaryButton dangerText"
            type="button"
            onClick={() => {
              const result = resetRelationshipMemory(memory, memory.scopeId);
              if (result.ok) onMemoryChange(result.value);
            }}
          ><RotateCcw size={15} />清空关系记忆</button>
        </section>
      ) : null}

      <section className="memoryList" aria-label="memory summaries">
        {summaries.length === 0 ? (
          <div className="memoryEmpty">
            <Brain size={26} />
            <strong>当前会话还没有记忆摘要。</strong>
          </div>
        ) : summaries.map((summary, index) => (
          <article className="memoryItem" key={`${summary.createdAt}-${index}`}>
            <header>
              <strong>总结 #{summaries.length - index}</strong>
              <time dateTime={new Date(summary.createdAt).toISOString()}>
                <Clock3 size={14} />
                <span>{formatMemoryTime(summary.createdAt)}</span>
              </time>
            </header>
            <p>{summary.content}</p>
          </article>
        ))}
      </section>
    </section>
  );
}

function MemoryChips({ title, empty, values }: { title: string; empty: string; values: readonly string[] }) {
  return (
    <section>
      <strong>{title}</strong>
      <div className="memoryChips">
        {values.length ? values.map((value, index) => <span key={`${value}-${index}`}>{value}</span>) : <i>{empty}</i>}
      </div>
    </section>
  );
}

function HistoryView({
  sessions,
  activeSessionId,
  sessionQuery,
  setSessionQuery,
  createNewSession,
  selectSession,
  deleteSession
}: {
  sessions: ChatSession[];
  activeSessionId: string;
  sessionQuery: string;
  setSessionQuery: (value: string) => void;
  createNewSession: () => void;
  selectSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
}) {
  return (
    <section className="historyConsole">
      <div className="historyControls">
        <div className="searchBox">
          <Search size={15} />
          <input value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder="搜索历史" />
        </div>
        <button className="primaryAction" type="button" onClick={createNewSession}>
          <Plus size={16} />
          <span>新会话</span>
        </button>
      </div>

      <section className="sessionList" aria-label="history">
        {sessions.map((session) => (
          <article className={`sessionItem ${session.id === activeSessionId ? "active" : ""}`} key={session.id}>
            <button type="button" onClick={() => selectSession(session.id)}>
              <strong>{session.title}</strong>
              <span>{session.messages.length} 条 · {formatTime(session.updatedAt)}</span>
            </button>
            <button className="iconButton dangerText" type="button" onClick={() => deleteSession(session.id)} title="删除会话">
              <Trash2 size={16} />
            </button>
          </article>
        ))}
      </section>
    </section>
  );
}

function ModelsView({
  config,
  deviceSnapshot,
  settings,
  setSettings,
  onReset
}: {
  config: RuntimeConfig;
  deviceSnapshot: DeviceBridgeSnapshot;
  settings: AgentSettings;
  setSettings: Dispatch<SetStateAction<AgentSettings>>;
  onReset: () => void;
}) {
  return (
    <section className="managementGrid">
      <SettingsSection icon={<SlidersHorizontal size={18} />} title="对话模型">
        <Field label="Chat model">
          {config.allowedModels?.llm.length ? (
            <select value={settings.llmModel} onChange={(event) => setSettings((current) => ({ ...current, llmModel: event.target.value }))}>
              {config.allowedModels.llm.map((model) => <option key={model}>{model}</option>)}
            </select>
          ) : <input value={settings.llmModel} onChange={(event) => setSettings((current) => ({ ...current, llmModel: event.target.value }))} />}
        </Field>
        <Field label={`Temperature · ${settings.temperature.toFixed(2)}`}>
          <input
            type="range"
            min="0"
            max="1.5"
            step="0.05"
            value={settings.temperature}
            onChange={(event) => setSettings((current) => ({ ...current, temperature: Number(event.target.value) }))}
          />
        </Field>
        <div className="fieldHint">当前环境值：{config.llmModel}</div>
      </SettingsSection>

      <SettingsSection icon={<Mic size={18} />} title="识别模型">
        <Field label="ASR model">
          {config.allowedModels?.asr.length ? (
            <select value={settings.asrModel} onChange={(event) => setSettings((current) => ({ ...current, asrModel: event.target.value }))}>
              {config.allowedModels.asr.map((model) => <option key={model}>{model}</option>)}
            </select>
          ) : <input value={settings.asrModel} onChange={(event) => setSettings((current) => ({ ...current, asrModel: event.target.value }))} />}
        </Field>
        <div className="fieldHint">当前环境值：{config.asrModel}</div>
      </SettingsSection>

      <SettingsSection icon={<CheckCircle2 size={18} />} title="运行状态">
        <div className="kvList">
          <span>Backend</span><strong>{config.ready ? "ready" : "missing key"}</strong>
          <span>LLM</span><strong>{settings.llmModel}</strong>
          <span>ASR</span><strong>{settings.asrModel}</strong>
          <span>TTS</span><strong>{settings.ttsModel}</strong>
          <span>iPhone bridge</span><strong>{deviceConnectionLabel(deviceSnapshot)}</strong>
          <span>iPhone abilities</span><strong>{deviceSnapshot.capabilities.length || "—"}</strong>
        </div>
        {config.deviceControlEnabled ? (
          <a className="secondaryButton" href="/device-control"><Smartphone size={15} />打开配对与审计</a>
        ) : null}
        <button className="secondaryButton" type="button" onClick={onReset}>
          <RotateCcw size={15} />
          <span>恢复默认</span>
        </button>
      </SettingsSection>
    </section>
  );
}

function VoiceView({
  config,
  settings,
  setSettings,
  voiceCloneLabel,
  voiceTestStatus,
  phase,
  onTestVoice
}: {
  config: RuntimeConfig;
  settings: AgentSettings;
  setSettings: Dispatch<SetStateAction<AgentSettings>>;
  voiceCloneLabel: string;
  voiceTestStatus: string;
  phase: Phase;
  onTestVoice: () => void;
}) {
  const voiceOptions: Array<{ value: VoiceMode; label: string }> = [
    { value: "auto", label: "情绪自动" },
    { value: "soft", label: "Soyo soft" },
    { value: "natural", label: "Soyo natural" },
    { value: "default", label: "默认音色" },
    { value: "custom", label: "自定义" }
  ];

  return (
    <section className="managementGrid">
      <SettingsSection icon={<Headphones size={18} />} title="语音模型">
        <Field label="TTS model">
          {config.allowedModels?.tts.length ? (
            <select value={settings.ttsModel} onChange={(event) => setSettings((current) => ({ ...current, ttsModel: event.target.value }))}>
              {config.allowedModels.tts.map((model) => <option key={model}>{model}</option>)}
            </select>
          ) : <input value={settings.ttsModel} onChange={(event) => setSettings((current) => ({ ...current, ttsModel: event.target.value }))} />}
        </Field>
        <div className="segmentedControl">
          {voiceOptions.map((option) => (
            <button
              className={settings.voiceMode === option.value ? "active" : ""}
              type="button"
              key={option.value}
              onClick={() => setSettings((current) => ({ ...current, voiceMode: option.value }))}
            >
              {option.label}
            </button>
          ))}
        </div>
        {settings.voiceMode === "custom" ? (
          <Field label="Custom voice id">
            <input value={settings.customVoice} onChange={(event) => setSettings((current) => ({ ...current, customVoice: event.target.value }))} />
          </Field>
        ) : null}
      </SettingsSection>

      <SettingsSection icon={<Volume2 size={18} />} title="音色配置">
        <div className="kvList">
          <span>Status</span><strong>{voiceCloneLabel}</strong>
          <span>Default</span><strong>{config.ttsVoice}</strong>
          <span>Soft</span><strong>{config.ttsVoices.soft}</strong>
          <span>Natural</span><strong>{config.ttsVoices.natural}</strong>
        </div>
        <button
          className="secondaryButton"
          type="button"
          onClick={onTestVoice}
          disabled={phase === "listening" || phase === "thinking" || phase === "buffering" || phase === "speaking"}
        >
          <Play size={15} />
          <span>测试音色</span>
        </button>
        <div className="fieldHint">{voiceTestStatus || "ready"}</div>
      </SettingsSection>
    </section>
  );
}

function CharacterView({
  config,
  settings,
  setSettings,
  emotion,
  action,
  performancePlan,
  capabilities,
  lastInteraction,
  live2dError,
  onPreview,
  onReset
}: {
  config: RuntimeConfig;
  settings: AgentSettings;
  setSettings: Dispatch<SetStateAction<AgentSettings>>;
  emotion: AgentEmotion;
  action: AgentAction;
  performancePlan: PerformancePlan | null;
  capabilities: Live2DCapabilityReport | null;
  lastInteraction: Live2DInteraction | null;
  live2dError: string;
  onPreview: (emotion: AgentEmotion, action: AgentAction, gaze?: GazeDirection) => void;
  onReset: () => void;
}) {
  const previews: Array<{ label: string; emotion: AgentEmotion; action: AgentAction; gaze?: GazeDirection }> = [
    { label: "轻点头", emotion: "neutral", action: "nod", gaze: "user" },
    { label: "克制微笑", emotion: "happy", action: "comfort", gaze: "user" },
    { label: "侧目思考", emotion: "worried", action: "think", gaze: "away" },
    { label: "害羞回应", emotion: "shy", action: "nod", gaze: "down" },
    { label: "挥手", emotion: "happy", action: "wave", gaze: "user" },
    { label: "认真", emotion: "determined", action: "deny", gaze: "user" }
  ];

  return (
    <section className="managementGrid">
      <SettingsSection icon={<UserRound size={18} />} title="Live2D 模型">
        <Field label="Model path">
          <input
            value={settings.live2dModelPath}
            onChange={(event) => setSettings((current) => ({ ...current, live2dModelPath: event.target.value }))}
          />
        </Field>
        <div className="fieldHint">当前环境值：{config.live2dModelPath}</div>
        <button className="secondaryButton" type="button" onClick={onReset}>
          <RotateCcw size={15} />
          <span>恢复路径</span>
        </button>
      </SettingsSection>

      <SettingsSection icon={<Layers3 size={18} />} title="舞台与渲染">
        <Field label="构图">
          <select value={settings.stagePreset} onChange={(event) => setSettings((current) => ({ ...current, stagePreset: event.target.value as StagePreset }))}>
            <option value="portrait">半身肖像</option>
            <option value="bust">近景特写</option>
            <option value="full-body">全身</option>
            <option value="obs">OBS / 直播</option>
          </select>
        </Field>
        <Field label="场景主题">
          <select value={settings.stageTheme} onChange={(event) => setSettings((current) => ({ ...current, stageTheme: event.target.value as StageTheme }))}>
            <option value="atrium">玻璃中庭</option>
            <option value="night">雨夜</option>
            <option value="studio">摄影棚</option>
            <option value="transparent">透明</option>
          </select>
        </Field>
        <Field label="画质">
          <select value={settings.renderQuality} onChange={(event) => setSettings((current) => ({ ...current, renderQuality: event.target.value as RenderQuality }))}>
            <option value="auto">自动</option>
            <option value="performance">省电</option>
            <option value="balanced">均衡</option>
            <option value="high">高画质</option>
          </select>
        </Field>
        <label className="toggleField">
          <input
            type="checkbox"
            checked={settings.interactionEnabled}
            onChange={(event) => setSettings((current) => ({ ...current, interactionEnabled: event.target.checked }))}
          />
          <span>允许点击模型触发本地反馈</span>
        </label>
        <label className="toggleField">
          <input
            type="checkbox"
            checked={settings.perceptionEnabled}
            onChange={(event) => setSettings((current) => ({
              ...current,
              perceptionEnabled: event.target.checked,
              ...(!event.target.checked ? { perceptionFrameEscalation: false } : {})
            }))}
          />
          <span>允许接收 iPhone 语义感知（默认关闭）</span>
        </label>
        <label className="toggleField">
          <input
            type="checkbox"
            checked={settings.perceptionFrameEscalation}
            disabled={!settings.perceptionEnabled}
            onChange={(event) => setSettings((current) => ({ ...current, perceptionFrameEscalation: event.target.checked }))}
          />
          <span>连续确认后允许单帧送入视觉模型</span>
        </label>
        <div className="fieldHint">画面只用于当前请求，不写入聊天记录或关系记忆。</div>
      </SettingsSection>

      <SettingsSection icon={<UserRound size={18} />} title="Soyo 微表演">
        <div className="previewGrid">
          {previews.map((preview) => (
            <button
              type="button"
              key={preview.label}
              onClick={() => onPreview(preview.emotion, preview.action, preview.gaze)}
            >
              {preview.label}
            </button>
          ))}
        </div>
        <div className="kvList">
          <span>Emotion</span><strong>{emotion}</strong>
          <span>Action</span><strong>{action}</strong>
          <span>Gaze</span><strong>{performancePlan?.defaultGaze ?? "auto"}</strong>
          <span>Cues</span><strong>{performancePlan?.cues.length ?? 0}</strong>
        </div>
      </SettingsSection>

      <SettingsSection icon={<Activity size={18} />} title="模型能力诊断">
        {live2dError ? <div className="inlineError">{live2dError}</div> : null}
        <div className="kvList">
          <span>Runtime</span><strong>{capabilities ? `Cubism ${capabilities.cubismVersion}` : "loading"}</strong>
          <span>Motions</span><strong>{capabilities ? Object.keys(capabilities.motionGroups).length : 0}</strong>
          <span>Expressions</span><strong>{capabilities?.expressionNames.length ?? 0}</strong>
          <span>Hit areas</span><strong>{capabilities?.hitAreas.join(", ") || "none"}</strong>
          <span>Lip sync</span><strong>{capabilities?.supports.lipSync ? "ready" : "fallback"}</strong>
          <span>Last touch</span><strong>{lastInteraction?.hitAreas.join(", ") || "none"}</strong>
        </div>
        {capabilities?.warnings.length ? (
          <ul className="capabilityWarnings">
            {capabilities.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        ) : null}
      </SettingsSection>

      <SettingsSection icon={<Save size={18} />} title="演出协议">
        <div className="kvList">
          <span>Schema</span><strong>{performancePlan ? `v${performancePlan.schemaVersion}` : "v2 ready"}</strong>
          <span>Turn</span><strong>{performancePlan?.turnId ?? "—"}</strong>
          <span>Scene</span><strong>capability-safe</strong>
          <span>Storage</span><strong>local settings</strong>
        </div>
      </SettingsSection>
    </section>
  );
}

function SettingsSection({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="settingsSection">
      <header>
        <span>{icon}</span>
        <strong>{title}</strong>
      </header>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function createSession(): ChatSession {
  const now = Date.now();
  const id = createId();
  return {
    id,
    title: "新的会话",
    createdAt: now,
    updatedAt: now,
    messages: [],
    memorySummary: "",
    memorySummaries: [],
    relationshipMemory: createRelationshipMemory(id, now)
  };
}

function bootstrapSessions(): Promise<ChatSession[]> {
  if (sessionBootstrapPromise) return sessionBootstrapPromise;

  const pending = (async () => {
    const response = await agentFetch(apiUrl("/api/sessions"));
    if (!response.ok) throw new Error(await response.text());
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error("会话服务返回了无效数据");
    const sessions = payload.map(hydrateChatSession);
    if (sessions.length > 0) return sessions;

    const createResponse = await agentFetch(apiUrl("/api/sessions"), { method: "POST" });
    if (!createResponse.ok) throw new Error(await createResponse.text());
    return [hydrateChatSession(await createResponse.json())];
  })();
  sessionBootstrapPromise = pending;
  const clear = () => {
    if (sessionBootstrapPromise === pending) sessionBootstrapPromise = null;
  };
  void pending.then(clear, clear);
  return pending;
}

function persistAndReturn(session: ChatSession, persist: (session: ChatSession) => Promise<void>) {
  void persist(session);
  return session;
}

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createTitle(content: string) {
  return content.trim().replace(/\s+/g, " ").slice(0, 22) || "新的会话";
}

function hydrateChatSession(value: unknown): ChatSession {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) {
    throw new Error("会话数据缺少有效 ID");
  }
  const createdAt = typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : Date.now();
  const updatedAt = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : createdAt;
  const relationshipMemory = hydrateRelationshipMemory(value.relationshipMemory, value.id, updatedAt);
  return {
    id: value.id,
    title: typeof value.title === "string" && value.title ? value.title : "新的会话",
    createdAt,
    updatedAt,
    messages: Array.isArray(value.messages)
      ? value.messages.filter((item): item is ChatMessage => (
          isRecord(item)
          && (item.role === "user" || item.role === "assistant")
          && typeof item.content === "string"
        ))
      : [],
    memorySummary: typeof value.memorySummary === "string" ? value.memorySummary : "",
    memorySummaries: Array.isArray(value.memorySummaries)
      ? value.memorySummaries.filter((item): item is MemorySummaryEntry => (
          isRecord(item) && typeof item.content === "string" && typeof item.createdAt === "number"
        )).slice(-10)
      : [],
    relationshipMemory
  };
}

function relationshipMemoryContext(memory: RelationshipMemory): string {
  const view = inspectRelationshipMemory(memory);
  const compact = (limit: number) => JSON.stringify({
    preferredName: view.profile.preferredName,
    preferences: view.preferences.slice(-limit).map(({ category, value, sentiment, confidence }) => ({ category, value, sentiment, confidence })),
    facts: view.facts.slice(-limit).map(({ key, value, confidence }) => ({ key, value, confidence })),
    boundaries: view.boundaries.slice(-limit).map(({ topic, rule }) => ({ topic, rule })),
    relationship: view.relationship
  });
  const detailed = compact(8);
  return detailed.length <= 1_900 ? detailed : compact(3);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettings(): AgentSettings {
  const stored = readJson<Partial<AgentSettings>>(settingsKey);
  if (!stored || !isRecord(stored)) return { ...initialSettings };
  const temperature = typeof stored.temperature === "number" && Number.isFinite(stored.temperature)
    && stored.temperature >= 0 && stored.temperature <= 1.5
    ? stored.temperature
    : initialSettings.temperature;
  return {
    llmModel: safeSettingString(stored.llmModel, initialSettings.llmModel),
    temperature,
    asrModel: safeSettingString(stored.asrModel, initialSettings.asrModel),
    ttsModel: safeSettingString(stored.ttsModel, initialSettings.ttsModel),
    voiceMode: settingEnum(stored.voiceMode, ["auto", "soft", "natural", "default", "custom"], initialSettings.voiceMode),
    customVoice: safeSettingString(stored.customVoice, "", true),
    live2dModelPath: safeSettingString(stored.live2dModelPath, initialSettings.live2dModelPath),
    stagePreset: settingEnum(stored.stagePreset, ["portrait", "bust", "full-body", "obs"], initialSettings.stagePreset),
    stageTheme: settingEnum(stored.stageTheme, ["atrium", "night", "studio", "transparent"], initialSettings.stageTheme),
    renderQuality: settingEnum(stored.renderQuality, ["auto", "performance", "balanced", "high"], initialSettings.renderQuality),
    interactionEnabled: stored?.interactionEnabled !== false,
    perceptionEnabled: stored?.perceptionEnabled === true,
    perceptionFrameEscalation: stored?.perceptionFrameEscalation === true
  };
}

function safeSettingString(value: unknown, fallback: string, allowEmpty = false) {
  if (typeof value !== "string" || value.length > 2_048 || (!allowEmpty && !value.trim())) return fallback;
  return value;
}

function settingEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function hydrateSettings(current: AgentSettings, nextConfig: RuntimeConfig, force = false): AgentSettings {
  const llmAllowed = !nextConfig.allowedModels?.llm.length || nextConfig.allowedModels.llm.includes(current.llmModel);
  const asrAllowed = !nextConfig.allowedModels?.asr.length || nextConfig.allowedModels.asr.includes(current.asrModel);
  const ttsAllowed = !nextConfig.allowedModels?.tts.length || nextConfig.allowedModels.tts.includes(current.ttsModel);
  return {
    ...current,
    llmModel: force || !llmAllowed || ["qwen-plus-latest", initialSettings.llmModel].includes(current.llmModel)
      ? nextConfig.llmModel
      : current.llmModel,
    asrModel: force || !asrAllowed || current.asrModel === initialSettings.asrModel ? nextConfig.asrModel : current.asrModel,
    ttsModel: force || !ttsAllowed || current.ttsModel === initialSettings.ttsModel ? nextConfig.ttsModel : current.ttsModel,
    live2dModelPath: force || current.live2dModelPath === initialSettings.live2dModelPath
      ? nextConfig.live2dModelPath
      : current.live2dModelPath
  };
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(value);
}

function formatMemoryTime(value: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(value);
}

function viewLabel(view: View) {
  return {
    history: "Console",
    memory: "Long-term memory",
    models: "Model routing",
    voice: "Voice stack",
    character: "Character"
  }[view];
}

function viewTitle(view: View) {
  if (view === "history") return "历史会话";
  if (view === "memory") return "长期记忆";
  if (view === "models") return "对话模型与识别配置";
  if (view === "voice") return "语音模型与音色配置";
  return "Live2D 角色配置";
}

function validPerformancePlan(value: PerformancePlan | undefined): value is PerformancePlan {
  return Boolean(
    value
    && value.schemaVersion === 2
    && typeof value.turnId === "string"
    && typeof value.reply === "string"
    && value.affect
    && typeof value.affect.primary === "string"
    && Array.isArray(value.cues)
  );
}

function sceneClass(resourceId: string) {
  const scenes: Record<string, string> = {
    default: "scene-default",
    atrium: "scene-default",
    rain: "scene-rain",
    "rain-night": "scene-rain",
    night: "scene-rain",
    studio: "scene-studio",
    practice: "scene-studio"
  };
  return scenes[resourceId] ?? "scene-default";
}

function isBuiltInSoyoModel(modelPath: string) {
  const resource = SOYO_STAGE_MANIFEST.resources.find((item) => item.id === "soyo-model");
  return resource?.source.kind === "asset" && resource.source.path === modelPath;
}

function deviceConnectionLabel(snapshot: DeviceBridgeSnapshot) {
  if (snapshot.deviceConnected) return snapshot.device?.name ? `connected · ${snapshot.device.name}` : "connected";
  return {
    unpaired: "unpaired",
    connecting: "connecting",
    connected: "phone offline",
    reconnecting: "reconnecting",
    replaced: "controller replaced",
    expired: "expired"
  }[snapshot.state];
}

function perceptionLabel(kind: AcceptedPerceptionEvent["kind"]) {
  return {
    "person.appeared": "有人靠近",
    "person.left": "用户离开",
    "gesture.wave": "挥手",
    "expression.smile": "微笑",
    "attention.engaged": "正在注视",
    "content.inspect": "观察画面"
  }[kind];
}
