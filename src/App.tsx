import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import {
  Box,
  CheckCircle2,
  Headphones,
  History,
  Mic,
  MicOff,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings,
  SlidersHorizontal,
  Trash2,
  UserRound,
  Volume2,
  X
} from "lucide-react";
import { apiUrl, wsUrl } from "./api";
import { startVoiceCapture, type VoiceCapture } from "./audio";
import { Live2DStage } from "./live2d/Live2DStage";
import type { AgentAction, AgentEmotion, AgentReply, ChatMessage, RuntimeConfig } from "./types";

type AsrMessage =
  | { type: "asr-status"; status: string }
  | { type: "asr-error"; error: string }
  | { type: "asr-result"; text: string; final: boolean };

type Phase = "idle" | "listening" | "thinking" | "speaking" | "error";
type View = "history" | "models" | "voice" | "character";
type VoiceMode = "auto" | "soft" | "natural" | "default" | "custom";

type ChatSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};

type AgentSettings = {
  llmModel: string;
  temperature: number;
  asrModel: string;
  ttsModel: string;
  voiceMode: VoiceMode;
  customVoice: string;
  live2dModelPath: string;
};

type SyncedReply = {
  sessionId: string;
  fullText: string;
  visibleText: string;
};

const settingsKey = "soyo.agent.settings.v3";

const initialConfig: RuntimeConfig = {
  llmModel: "qwen-plus-latest",
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
  live2dModelPath: initialConfig.live2dModelPath
};

export default function App() {
  const [config, setConfig] = useState(initialConfig);
  const [settings, setSettings] = useState(() => readSettings());
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [draft, setDraft] = useState("");
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
  const wsRef = useRef<WebSocket | null>(null);
  const captureRef = useRef<VoiceCapture | null>(null);
  const lastFinalRef = useRef("");

  useEffect(() => {
    void fetch(apiUrl("/api/config"))
      .then((response) => response.json())
      .then((nextConfig: RuntimeConfig) => {
        setConfig(nextConfig);
        setSettings((current) => hydrateSettings(current, nextConfig));
        setStatus(nextConfig.ready ? "云端模型已就绪" : "等待配置密钥");
      })
      .catch(() => {
        setStatus("后端未连接");
        setPhase("error");
      });
  }, []);

  useEffect(() => {
    void loadSessions();
  }, []);

  useEffect(() => {
    localStorage.setItem(settingsKey, JSON.stringify(settings));
  }, [settings]);

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
  const messages = activeSession?.messages ?? [];
  const displayedMessages = useMemo(() => {
    if (!syncedReply || syncedReply.sessionId !== activeSession?.id || !syncedReply.visibleText) {
      return messages;
    }
    return [...messages, { role: "assistant", content: syncedReply.visibleText } satisfies ChatMessage];
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
    try {
      const response = await fetch(apiUrl("/api/sessions"));
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const nextSessions = await response.json() as ChatSession[];
      if (nextSessions.length > 0) {
        setSessions(nextSessions);
        setActiveSessionId((current) => nextSessions.some((session) => session.id === current) ? current : nextSessions[0].id);
        return;
      }

      const createResponse = await fetch(apiUrl("/api/sessions"), { method: "POST" });
      if (!createResponse.ok) {
        throw new Error(await createResponse.text());
      }
      const session = await createResponse.json() as ChatSession;
      setSessions([session]);
      setActiveSessionId(session.id);
    } catch (error) {
      const fallback = createSession();
      setSessions([fallback]);
      setActiveSessionId(fallback.id);
      setStatus(error instanceof Error ? `历史记录未连接：${error.message}` : "历史记录未连接");
    }
  }, []);

  const persistSession = useCallback(async (session: ChatSession) => {
    try {
      const response = await fetch(apiUrl(`/api/sessions/${session.id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: session.title,
          messages: session.messages
        })
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
    } catch (error) {
      setStatus(error instanceof Error ? `历史记录保存失败：${error.message}` : "历史记录保存失败");
    }
  }, []);

  const updateActiveSession = useCallback((updater: (session: ChatSession) => ChatSession) => {
    setSessions((current) => current.map((session) => (
      session.id === activeSessionId ? persistAndReturn(updater(session), persistSession) : session
    )));
  }, [activeSessionId, persistSession]);

  const createNewSession = useCallback(() => {
    void (async () => {
      try {
        const response = await fetch(apiUrl("/api/sessions"), { method: "POST" });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const session = await response.json() as ChatSession;
        setSessions((current) => [session, ...current]);
        setActiveSessionId(session.id);
        setSyncedReply(null);
        setDraft("");
        setTranscript("");
        setEmotion("neutral");
        setAction("idle");
        setPhase("idle");
        setStatus(config.ready ? "云端模型已就绪" : "等待配置密钥");
        setConsoleOpen(false);
      } catch (error) {
        setStatus(error instanceof Error ? `新建会话失败：${error.message}` : "新建会话失败");
      }
    })();
  }, [config.ready]);

  const deleteSession = useCallback((sessionId: string) => {
    void (async () => {
      try {
        const response = await fetch(apiUrl(`/api/sessions/${sessionId}`), { method: "DELETE" });
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
  }, [loadSessions]);

  const stopListening = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;
    wsRef.current?.send(JSON.stringify({ type: "stop" }));
    wsRef.current?.close();
    wsRef.current = null;
    setPhase((current) => current === "listening" ? "idle" : current);
  }, []);

  const resolveVoice = useCallback((replyEmotion?: AgentEmotion) => {
    if (settings.voiceMode === "soft") return config.ttsVoices.soft;
    if (settings.voiceMode === "natural") return config.ttsVoices.natural;
    if (settings.voiceMode === "default") return config.ttsVoice;
    if (settings.voiceMode === "custom") return settings.customVoice.trim() || undefined;
    return replyEmotion ? undefined : config.ttsVoices.soft;
  }, [config.ttsVoice, config.ttsVoices.natural, config.ttsVoices.soft, settings.customVoice, settings.voiceMode]);

  const sendToAgent = useCallback(async (text: string) => {
    const content = text.trim();
    const session = activeSession;
    if (!content || !session) {
      return;
    }

    const userMessage: ChatMessage = { role: "user", content };
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
    let pendingAssistantMessage: ChatMessage | null = null;
    let pendingAssistantMessages: ChatMessage[] | null = null;
    let assistantCommitted = false;

    const commitAssistantMessage = () => {
      if (assistantCommitted || !pendingAssistantMessage || !pendingAssistantMessages) {
        return;
      }
      const assistantMessage = pendingAssistantMessage;
      const assistantMessages = pendingAssistantMessages;
      assistantCommitted = true;
      updateActiveSession((current) => ({
        ...current,
        updatedAt: Date.now(),
        messages: [...assistantMessages, assistantMessage]
      }));
    };

    try {
      const chatResponse = await fetch(apiUrl("/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages,
          model: settings.llmModel,
          temperature: settings.temperature
        })
      });

      if (!chatResponse.ok) {
        throw new Error(await chatResponse.text());
      }

      const agentReply = await chatResponse.json() as AgentReply;
      pendingAssistantMessage = { role: "assistant", content: agentReply.reply };
      pendingAssistantMessages = nextMessages;
      setEmotion(agentReply.emotion);
      setAction(agentReply.action);
      setStatus("生成语音");

      const ttsResponse = await fetch(apiUrl("/api/tts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: agentReply.reply,
          instruction: agentReply.ttsInstruction,
          emotion: agentReply.emotion,
          model: settings.ttsModel,
          voice: resolveVoice(agentReply.emotion)
        })
      });

      if (!ttsResponse.ok) {
        throw new Error(await ttsResponse.text());
      }

      const audioBlob = await ttsResponse.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      let animationFrame = 0;

      const updateSyncedText = () => {
        const duration = Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : Math.max(agentReply.reply.length / 8, 1);
        const progress = Math.min(audio.currentTime / duration, 1);
        const visibleLength = Math.max(1, Math.ceil(agentReply.reply.length * progress));
        setSyncedReply({
          sessionId: session.id,
          fullText: agentReply.reply,
          visibleText: agentReply.reply.slice(0, visibleLength)
        });

        if (!audio.paused && !audio.ended) {
          animationFrame = window.requestAnimationFrame(updateSyncedText);
        }
      };

      const commitReply = () => {
        if (animationFrame) {
          window.cancelAnimationFrame(animationFrame);
        }
        setSyncedReply(null);
        commitAssistantMessage();
      };

      setPhase("speaking");
      setStatus(`说话中 · ${ttsResponse.headers.get("X-Soyo-TTS-Voice") ?? "voice"}`);
      audio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        commitReply();
        setPhase("idle");
        setStatus("空闲");
        setAction("idle");
      };
      audio.onerror = () => {
        URL.revokeObjectURL(audioUrl);
        commitReply();
        setPhase("error");
        setStatus("音频播放失败，已显示文字回复");
      };
      try {
        await audio.play();
      } catch (playError) {
        URL.revokeObjectURL(audioUrl);
        commitReply();
        throw playError;
      }
      setSyncedReply({
        sessionId: session.id,
        fullText: agentReply.reply,
        visibleText: agentReply.reply.slice(0, 1)
      });
      animationFrame = window.requestAnimationFrame(updateSyncedText);
    } catch (error) {
      setSyncedReply(null);
      commitAssistantMessage();
      setPhase("error");
      const message = error instanceof Error ? error.message : "请求失败";
      setStatus(pendingAssistantMessage ? `${message} · 已显示文字回复` : message);
    }
  }, [activeSession, resolveVoice, settings.llmModel, settings.temperature, settings.ttsModel, updateActiveSession]);

  const testVoice = useCallback(async () => {
    setVoiceTestStatus("生成测试音频");
    setStatus("生成测试音频");
    setPhase("thinking");

    try {
      const response = await fetch(apiUrl("/api/tts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "你好，我在这里。今天也请多指教。",
          instruction: "语气温柔、自然、稍微克制。",
          emotion: "happy",
          model: settings.ttsModel,
          voice: resolveVoice("happy")
        })
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      setVoiceTestStatus(response.headers.get("X-Soyo-TTS-Voice") ?? "播放测试音频");
      setStatus("测试音色");
      setPhase("speaking");
      setEmotion("happy");
      setAction("nod");
      audio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        setVoiceTestStatus("测试完成");
        setPhase("idle");
        setStatus("空闲");
        setAction("idle");
      };
      await audio.play();
    } catch (error) {
      setPhase("error");
      const message = error instanceof Error ? error.message : "音色测试失败";
      setStatus(message);
      setVoiceTestStatus(message);
    }
  }, [resolveVoice, settings.ttsModel]);

  const startListening = useCallback(async () => {
    if (phase === "listening") {
      stopListening();
      return;
    }

    setPhase("listening");
    setStatus("连接识别服务");
    setTranscript("");
    lastFinalRef.current = "";

    const ws = new WebSocket(wsUrl(`/ws/asr?model=${encodeURIComponent(settings.asrModel)}`));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = async () => {
      ws.send(JSON.stringify({ type: "start" }));
      captureRef.current = await startVoiceCapture((chunk) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(chunk);
        }
      });
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as AsrMessage;
      if (message.type === "asr-status") {
        setStatus(message.status === "started" ? "正在听" : message.status);
        return;
      }
      if (message.type === "asr-error") {
        setPhase("error");
        setStatus(message.error);
        return;
      }
      if (message.type === "asr-result") {
        setTranscript(message.text);
        if (message.final && message.text.trim() && message.text !== lastFinalRef.current) {
          lastFinalRef.current = message.text;
          stopListening();
          void sendToAgent(message.text);
        }
      }
    };

    ws.onerror = () => {
      setPhase("error");
      setStatus("语音连接失败");
    };
  }, [phase, sendToAgent, settings.asrModel, stopListening]);

  useEffect(() => stopListening, [stopListening]);

  const statusTone = useMemo(() => {
    if (phase === "error") return "danger";
    if (phase === "listening") return "live";
    if (phase === "speaking") return "speaking";
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

  return (
    <main className={`soyoExperience ${keyboardOpen ? "keyboardOpen" : ""}`}>
      <Live2DStage modelPath={settings.live2dModelPath} emotion={emotion} action={action} speaking={phase === "speaking"} keyboardOpen={keyboardOpen} />
      <div className="stageWash" />

      <header className="experienceTopbar">
        <div className={`statusPill ${statusTone}`}>
          <span />
          <strong>{status}</strong>
        </div>
        <button className="settingsFab" type="button" onClick={() => setConsoleOpen(true)} title="设置">
          <Settings size={21} />
        </button>
      </header>

      <StageChatDock
        messages={displayedMessages}
        draft={draft}
        phase={phase}
        transcript={transcript}
        sessionTitle={activeSession?.title ?? "实时语音对话"}
        conversationVisible={chatVisible}
        onDraftChange={setDraft}
        onSubmit={() => void sendToAgent(draft)}
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
          activeSessionId={activeSession?.id ?? ""}
          sessionQuery={sessionQuery}
          setSessionQuery={setSessionQuery}
          createNewSession={createNewSession}
          selectSession={(sessionId) => {
            setActiveSessionId(sessionId);
            setConsoleOpen(false);
          }}
          deleteSession={deleteSession}
          config={config}
          settings={settings}
          setSettings={setSettings}
          saveServerDefaults={saveServerDefaults}
          voiceCloneLabel={voiceCloneLabel}
          voiceTestStatus={voiceTestStatus}
          phase={phase}
          testVoice={() => void testVoice()}
          emotion={emotion}
          action={action}
          close={() => setConsoleOpen(false)}
        />
      ) : null}
    </main>
  );
}

function StageChatDock({
  messages,
  draft,
  phase,
  transcript,
  sessionTitle,
  conversationVisible,
  onDraftChange,
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
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onListen: () => void;
  onRevealConversation: () => void;
}) {
  const busy = phase === "thinking" || phase === "speaking";

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
          disabled={busy}
          title={phase === "listening" ? "停止收音" : "开始收音"}
        >
          {phase === "listening" ? <MicOff size={22} /> : <Mic size={22} />}
        </button>
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="和 Soyo 说点什么..."
          disabled={busy}
          rows={1}
        />
        <button className="sendButton" type="submit" disabled={!draft.trim() || busy} title="发送">
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
  activeSessionId,
  sessionQuery,
  setSessionQuery,
  createNewSession,
  selectSession,
  deleteSession,
  config,
  settings,
  setSettings,
  saveServerDefaults,
  voiceCloneLabel,
  voiceTestStatus,
  phase,
  testVoice,
  emotion,
  action,
  close
}: {
  view: View;
  setView: Dispatch<SetStateAction<View>>;
  statusTone: string;
  status: string;
  sessions: ChatSession[];
  activeSessionId: string;
  sessionQuery: string;
  setSessionQuery: (value: string) => void;
  createNewSession: () => void;
  selectSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  config: RuntimeConfig;
  settings: AgentSettings;
  setSettings: Dispatch<SetStateAction<AgentSettings>>;
  saveServerDefaults: () => void;
  voiceCloneLabel: string;
  voiceTestStatus: string;
  phase: Phase;
  testVoice: () => void;
  emotion: AgentEmotion;
  action: AgentAction;
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

        {view === "models" ? (
          <ModelsView config={config} settings={settings} setSettings={setSettings} onReset={saveServerDefaults} />
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

function ChatView({
  messages,
  draft,
  phase,
  transcript,
  onDraftChange,
  onSubmit,
  onListen,
  onDeleteSession
}: {
  messages: ChatMessage[];
  draft: string;
  phase: Phase;
  transcript: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onListen: () => void;
  onDeleteSession: () => void;
}) {
  return (
    <section className="chatPane">
      <div className="chatToolbar">
        <div className="metricStrip">
          <span>{messages.length} messages</span>
          <span>{phase}</span>
        </div>
        <button className="ghostButton dangerText" type="button" onClick={onDeleteSession} title="删除当前会话">
          <Trash2 size={15} />
          <span>删除</span>
        </button>
      </div>

      <section className="conversation" aria-label="conversation">
        {messages.length === 0 ? (
          <div className="emptyState">
            <Volume2 size={26} />
            <strong>等你开口。</strong>
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

      <form className="composer" onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}>
        <button
          className={`micButton ${phase === "listening" ? "active" : ""}`}
          type="button"
          onClick={onListen}
          title={phase === "listening" ? "停止收音" : "开始收音"}
        >
          {phase === "listening" ? <MicOff size={22} /> : <Mic size={22} />}
        </button>
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="也可以打字..."
          disabled={phase === "thinking"}
          rows={1}
        />
        <button className="sendButton" type="submit" disabled={!draft.trim() || phase === "thinking"} title="发送">
          <Send size={20} />
        </button>
      </form>
    </section>
  );
}

function ModelsView({
  config,
  settings,
  setSettings,
  onReset
}: {
  config: RuntimeConfig;
  settings: AgentSettings;
  setSettings: Dispatch<SetStateAction<AgentSettings>>;
  onReset: () => void;
}) {
  return (
    <section className="managementGrid">
      <SettingsSection icon={<SlidersHorizontal size={18} />} title="对话模型">
        <Field label="Chat model">
          <input value={settings.llmModel} onChange={(event) => setSettings((current) => ({ ...current, llmModel: event.target.value }))} />
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
          <input value={settings.asrModel} onChange={(event) => setSettings((current) => ({ ...current, asrModel: event.target.value }))} />
        </Field>
        <div className="fieldHint">当前环境值：{config.asrModel}</div>
      </SettingsSection>

      <SettingsSection icon={<CheckCircle2 size={18} />} title="运行状态">
        <div className="kvList">
          <span>Backend</span><strong>{config.ready ? "ready" : "missing key"}</strong>
          <span>LLM</span><strong>{settings.llmModel}</strong>
          <span>ASR</span><strong>{settings.asrModel}</strong>
          <span>TTS</span><strong>{settings.ttsModel}</strong>
        </div>
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
          <input value={settings.ttsModel} onChange={(event) => setSettings((current) => ({ ...current, ttsModel: event.target.value }))} />
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
          disabled={phase === "listening" || phase === "thinking" || phase === "speaking"}
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
  onReset
}: {
  config: RuntimeConfig;
  settings: AgentSettings;
  setSettings: Dispatch<SetStateAction<AgentSettings>>;
  emotion: AgentEmotion;
  action: AgentAction;
  onReset: () => void;
}) {
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

      <SettingsSection icon={<Box size={18} />} title="角色状态">
        <div className="kvList">
          <span>Emotion</span><strong>{emotion}</strong>
          <span>Action</span><strong>{action}</strong>
          <span>Model</span><strong>{settings.live2dModelPath}</strong>
        </div>
      </SettingsSection>

      <SettingsSection icon={<Save size={18} />} title="本地配置">
        <div className="kvList">
          <span>Storage</span><strong>local</strong>
          <span>Sessions</span><strong>enabled</strong>
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
  return {
    id: createId(),
    title: "新的会话",
    createdAt: now,
    updatedAt: now,
    messages: []
  };
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

function readSettings(): AgentSettings {
  return { ...initialSettings, ...readJson<Partial<AgentSettings>>(settingsKey) };
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
  return {
    ...current,
    llmModel: force || current.llmModel === initialSettings.llmModel ? nextConfig.llmModel : current.llmModel,
    asrModel: force || current.asrModel === initialSettings.asrModel ? nextConfig.asrModel : current.asrModel,
    ttsModel: force || current.ttsModel === initialSettings.ttsModel ? nextConfig.ttsModel : current.ttsModel,
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

function viewLabel(view: View) {
  return {
    history: "Console",
    models: "Model routing",
    voice: "Voice stack",
    character: "Character"
  }[view];
}

function viewTitle(view: View) {
  if (view === "history") return "历史会话";
  if (view === "models") return "对话模型与识别配置";
  if (view === "voice") return "语音模型与音色配置";
  return "Live2D 角色配置";
}
