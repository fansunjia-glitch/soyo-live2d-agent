import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl, wsUrl } from "../api";
import {
  clearStoredPairing,
  readStoredPairing,
  storePairing,
  type ControlLog,
  type DeviceAuditEvent,
  type PairingCredentials,
  type PairingStatus
} from "./types";
import "./device-control.css";

type SocketState = "disconnected" | "connecting" | "connected";

export function DeviceControlConsole() {
  const [adminToken, setAdminToken] = useState("");
  const [pairing, setPairing] = useState<PairingCredentials | null>(() => readStoredPairing());
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [socketState, setSocketState] = useState<SocketState>("disconnected");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [openUrl, setOpenUrl] = useState("https://www.apple.com.cn/");
  const [text, setText] = useState("来自 Soyo Agent 的测试消息");
  const [shortcutName, setShortcutName] = useState("");
  const [screenFrame, setScreenFrame] = useState("");
  const [lastLocation, setLastLocation] = useState<{ latitude: number; longitude: number; accuracy: number; at: number } | null>(null);
  const [logs, setLogs] = useState<ControlLog[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const shouldReconnectRef = useRef(true);

  const appendLog = useCallback((message: string, tone: ControlLog["tone"] = "info") => {
    setLogs((current) => [
      { id: createId(), at: Date.now(), tone, message },
      ...current
    ].slice(0, 100));
  }, []);

  const clearPairing = useCallback((expectedPairingId?: string) => {
    if (expectedPairingId && readStoredPairing()?.pairingId !== expectedPairingId) return;
    shouldReconnectRef.current = false;
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    clearStoredPairing(expectedPairingId);
    setPairing(null);
    setStatus(null);
    setSocketState("disconnected");
    setScreenFrame("");
    setLastLocation(null);
  }, []);

  const handleSocketMessage = useCallback((payload: Record<string, unknown>) => {
    const type = String(payload.type || "");
    if (type === "pairing_status") {
      setStatus(payload as unknown as PairingStatus);
      setSocketState("connected");
      reconnectAttemptRef.current = 0;
      appendLog("控制通道已认证", "success");
      return;
    }
    if (type === "device_state") {
      if (!payload.connected) setScreenFrame("");
      setStatus((current) => current ? {
        ...current,
        deviceConnected: Boolean(payload.connected),
        device: (payload.device as PairingStatus["device"]) ?? current.device,
        state: current.state === "waiting" && payload.connected ? "paired" : current.state
      } : current);
      appendLog(payload.connected ? "iPhone 已上线" : "iPhone 已离线", payload.connected ? "success" : "warning");
      return;
    }
    if (type === "device_hello" || type === "device_state") {
      appendLog("收到设备状态");
      return;
    }
    if (type === "screen_frame") {
      const dataUrl = typeof payload.dataUrl === "string" ? payload.dataUrl : "";
      if (dataUrl.startsWith("data:image/jpeg;base64,")) setScreenFrame(dataUrl);
      return;
    }
    if (type === "command_accepted") {
      appendLog(`命令已送达：${String(payload.action || "unknown")}`);
      return;
    }
    if (type === "approval_required") {
      appendLog(`等待手机确认：${String(payload.action || "unknown")}`, "warning");
      return;
    }
    if (type === "approval_result") {
      appendLog(payload.ok ? "用户已允许命令" : "用户拒绝了命令", payload.ok ? "success" : "warning");
      return;
    }
    if (type === "command_result") {
      const action = String(payload.action || "命令");
      const message = typeof payload.message === "string" ? payload.message : "";
      const resultData = typeof payload.data === "object" && payload.data !== null
        ? payload.data as Record<string, unknown>
        : {};
      const dataUrl = typeof payload.dataUrl === "string"
        ? payload.dataUrl
        : typeof resultData.dataUrl === "string"
          ? resultData.dataUrl
          : typeof resultData.imageDataUrl === "string" ? resultData.imageDataUrl : "";
      if (dataUrl.startsWith("data:image/jpeg;base64,")) setScreenFrame(dataUrl);
      if (action === "screen_share.stop" && payload.ok) setScreenFrame("");
      if (action === "device.location_once") {
        const latitude = Number(resultData.latitude);
        const longitude = Number(resultData.longitude);
        const accuracy = Number(resultData.horizontalAccuracy);
        const at = Number(resultData.timestamp);
        if (Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
          && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
          && Number.isFinite(accuracy) && accuracy >= 0 && Number.isFinite(at)) {
          setLastLocation({ latitude, longitude, accuracy, at });
        }
      }
      if (action === "device.info") {
        const capabilities = Array.isArray(resultData.capabilities)
          ? resultData.capabilities.filter((item): item is string => typeof item === "string").slice(0, 50)
          : undefined;
        setStatus((current) => current ? {
          ...current,
          device: current.device ? {
            ...current.device,
            ...(typeof resultData.name === "string" ? { name: resultData.name } : {}),
            ...(typeof resultData.model === "string" ? { model: resultData.model } : {}),
            ...(typeof resultData.systemName === "string" ? { systemName: resultData.systemName } : {}),
            ...(typeof resultData.systemVersion === "string" ? { systemVersion: resultData.systemVersion } : {}),
            ...(typeof resultData.appVersion === "string" ? { appVersion: resultData.appVersion } : {}),
            ...(capabilities ? { capabilities } : {})
          } : current.device
        } : current);
      }
      appendLog(`${action}：${payload.ok ? "完成" : "失败"}${message ? ` · ${message}` : ""}`, payload.ok ? "success" : "error");
      return;
    }
    if (type === "error") {
      const message = String(payload.error || "控制通道错误");
      setError(message);
      appendLog(message, "error");
      return;
    }
    if (type === "pairing_revoked") {
      appendLog("配对已撤销", "warning");
      clearPairing();
      return;
    }
    if (type === "event") {
      appendLog("收到经过配对设备的语义感知事件");
      return;
    }
    if (type && type !== "pong") appendLog(`设备事件：${type}`);
  }, [appendLog, clearPairing]);

  const connectSocket = useCallback((credentials: PairingCredentials) => {
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    const previous = socketRef.current;
    socketRef.current = null;
    if (previous) {
      previous.onclose = null;
      previous.close();
    }
    setSocketState("connecting");
    shouldReconnectRef.current = true;
    const socket = new WebSocket(wsUrl("/ws/device-control/controller"));
    socketRef.current = socket;

    socket.onopen = () => {
      if (socketRef.current !== socket) return;
      socket.send(JSON.stringify({
        type: "authenticate",
        schemaVersion: 1,
        pairingId: credentials.pairingId,
        token: credentials.controllerToken
      }));
      setError("");
    };
    socket.onmessage = (event) => {
      if (socketRef.current !== socket) return;
      try {
        handleSocketMessage(JSON.parse(String(event.data)) as Record<string, unknown>);
      } catch {
        appendLog("收到无法解析的设备消息", "error");
      }
    };
    socket.onerror = () => {
      if (socketRef.current === socket) setError("控制通道连接失败");
    };
    socket.onclose = (event) => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      setSocketState("disconnected");
      setScreenFrame("");
      if (event.code === 4003 || event.code === 4401) {
        appendLog("控制凭据已失效，已停止重连", "warning");
        clearPairing(credentials.pairingId);
        return;
      }
      if (event.code === 4009) {
        shouldReconnectRef.current = false;
        setStatus((current) => current ? { ...current, controllerConnected: false } : current);
        appendLog("另一个控制端已接管配对；已停止自动重连", "warning");
        return;
      }
      if (shouldReconnectRef.current && Date.now() < credentials.expiresAt) {
        const attempt = reconnectAttemptRef.current++;
        const delay = Math.min(30_000, 1_800 * (2 ** Math.min(attempt, 4)));
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          if (shouldReconnectRef.current) connectSocket(credentials);
        }, delay);
      }
    };
  }, [appendLog, clearPairing, handleSocketMessage]);

  const refreshStatus = useCallback(async (credentials: PairingCredentials, signal?: AbortSignal) => {
    const response = await fetch(apiUrl(`/api/device-control/pairings/${credentials.pairingId}`), {
      headers: { Authorization: `Bearer ${credentials.controllerToken}` },
      signal
    });
    if (!response.ok) {
      if ([400, 401, 404].includes(response.status)) clearPairing(credentials.pairingId);
      throw new Error(await responseError(response));
    }
    const nextStatus = await response.json() as PairingStatus;
    if (signal?.aborted || readStoredPairing()?.pairingId !== credentials.pairingId) return;
    setStatus(nextStatus);
    if (nextStatus.expiresAt !== credentials.expiresAt) {
      const refreshed = { ...credentials, expiresAt: nextStatus.expiresAt };
      storePairing(refreshed);
      setPairing((current) => current?.pairingId === refreshed.pairingId ? refreshed : current);
    }
    if (nextStatus.state === "expired" || nextStatus.state === "revoked") {
      clearPairing(credentials.pairingId);
    }
  }, [clearPairing]);

  const refreshAudit = useCallback(async (credentials: PairingCredentials, signal?: AbortSignal) => {
    const response = await fetch(apiUrl(`/api/device-control/pairings/${credentials.pairingId}/audit`), {
      headers: { Authorization: `Bearer ${credentials.controllerToken}` },
      signal
    });
    if (!response.ok) throw new Error(await responseError(response));
    const audit = await response.json() as DeviceAuditEvent[];
    if (signal?.aborted || readStoredPairing()?.pairingId !== credentials.pairingId) return;
    setLogs(audit.slice(-100).reverse().map((event, index) => ({
      id: `${event.at}-${index}-${event.event}`,
      at: event.at,
      tone: auditTone(event),
      message: auditLabel(event)
    })));
  }, []);

  useEffect(() => {
    if (!pairing) return;
    const abortController = new AbortController();
    let refreshTimer: number | null = null;
    const refresh = async () => {
      await Promise.allSettled([
        refreshStatus(pairing, abortController.signal),
        refreshAudit(pairing, abortController.signal)
      ]);
      if (!abortController.signal.aborted) {
        refreshTimer = window.setTimeout(() => void refresh(), 2_500);
      }
    };
    void refresh().catch((nextError) => {
      if (!abortController.signal.aborted) setError(errorMessage(nextError));
    });
    connectSocket(pairing);
    return () => {
      abortController.abort();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [connectSocket, pairing, refreshAudit, refreshStatus]);

  const createPairing = async () => {
    if (!adminToken.trim()) {
      setError("请输入 DEVICE_CONTROL_ADMIN_TOKEN");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(apiUrl("/api/device-control/pairings"), {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken.trim()}` }
      });
      if (!response.ok) throw new Error(await responseError(response));
      const credentials = await response.json() as PairingCredentials;
      storePairing(credentials);
      setPairing(credentials);
      setAdminToken("");
      appendLog("已创建一次性配对码", "success");
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
  };

  const revokePairing = async () => {
    if (!pairing) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(apiUrl(`/api/device-control/pairings/${pairing.pairingId}`), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${pairing.controllerToken}` }
      });
      if (!response.ok) throw new Error(await responseError(response));
      appendLog("配对已撤销", "success");
      clearPairing(pairing.pairingId);
    } catch (nextError) {
      const message = `撤销失败，控制凭据已保留：${errorMessage(nextError)}`;
      setError(message);
      appendLog(message, "error");
    } finally {
      setBusy(false);
    }
  };

  const sendCommand = (action: string, params: Record<string, unknown> = {}) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("控制通道尚未连接");
      return;
    }
    const id = createId();
    socket.send(JSON.stringify({ type: "command", schemaVersion: 1, id, action, params }));
  };

  const remainingSeconds = pairing ? Math.max(0, Math.floor((pairing.expiresAt - Date.now()) / 1000)) : 0;
  const connected = socketState === "connected" && Boolean(status?.deviceConnected);

  return (
    <main className="deviceControlPage">
      <header className="deviceControlHeader">
        <div>
          <p className="eyebrow">SOYO PERSONAL DEVICE AGENT</p>
          <h1>iPhone 控制台</h1>
          <p>通过原生伴生端执行苹果允许的动作；每项敏感操作都在手机上确认。</p>
        </div>
        <a href="/">返回 Live2D</a>
      </header>

      <section className="deviceNotice">
        <strong>能力边界</strong>
        <span>可看屏、获取一次性位置、打开链接、朗读、复制文本和衔接快捷指令；不能绕过 iOS 沙箱向其他 App 注入点击。</span>
      </section>

      {error ? <div className="deviceError" role="alert">{error}</div> : null}

      <div className="deviceGrid">
        <section className="deviceCard pairingCard">
          <div className="cardTitle">
            <div><span>01</span><h2>安全配对</h2></div>
            <StatusDot active={connected} label={connected ? "设备在线" : socketState === "connecting" ? "连接中" : "未连接"} />
          </div>

          {!pairing ? (
            <div className="pairingForm">
              <label>
                <span>服务端管理口令</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={adminToken}
                  onChange={(event) => setAdminToken(event.target.value)}
                  placeholder="DEVICE_CONTROL_ADMIN_TOKEN"
                />
              </label>
              <button type="button" disabled={busy} onClick={() => void createPairing()}>
                {busy ? "创建中…" : "生成 6 位配对码"}
              </button>
              <p>管理口令只保存在当前页面内存中；控制令牌仅保存在这个标签页的 sessionStorage。</p>
            </div>
          ) : (
            <div className="pairingResult">
              <p>在 iPhone 伴生端输入</p>
              <strong className="pairingCode">{pairing.pairingCode}</strong>
              <div className="pairingMeta">
                <span>{status?.state === "paired" ? "已配对" : `约 ${Math.ceil(remainingSeconds / 60)} 分钟后过期`}</span>
                <span>{status?.device?.name ?? "等待 iPhone"}</span>
              </div>
              <button className="dangerButton" type="button" disabled={busy} onClick={() => void revokePairing()}>
                {busy ? "撤销中…" : "撤销并断开"}
              </button>
            </div>
          )}
        </section>

        <section className="deviceCard screenCard">
          <div className="cardTitle">
            <div><span>02</span><h2>共享画面</h2></div>
            <span className="subtle">用户主动开启</span>
          </div>
          <div className="phoneFrame">
            {screenFrame ? <img src={screenFrame} alt="iPhone 共享画面" /> : (
              <div className="screenPlaceholder">
                <span>iPhone</span>
                <p>开始共享后，低帧率预览会显示在这里。</p>
              </div>
            )}
          </div>
          <div className="buttonRow">
            <button type="button" disabled={!connected} onClick={() => sendCommand("screen_share.start")}>请求共享</button>
            <button className="secondaryButton" type="button" disabled={!connected} onClick={() => sendCommand("screen_share.stop")}>停止</button>
          </div>
        </section>

        <section className="deviceCard actionsCard">
          <div className="cardTitle"><div><span>03</span><h2>Agent 动作</h2></div></div>
          <div className="quickActions">
            <button type="button" disabled={!connected} onClick={() => sendCommand("device.info")}>刷新设备信息</button>
            <button type="button" disabled={!connected} onClick={() => sendCommand("device.location_once")}>请求一次位置</button>
            <button type="button" disabled={!connected} onClick={() => sendCommand("camera.capture")}>请求拍照</button>
          </div>
          {lastLocation ? (
            <div className="deviceResult" aria-live="polite">
              <strong>最近一次位置</strong>
              <span>{lastLocation.latitude.toFixed(6)}, {lastLocation.longitude.toFixed(6)}</span>
              <small>精度约 {Math.round(lastLocation.accuracy)} m · {new Date(lastLocation.at).toLocaleTimeString()}</small>
            </div>
          ) : null}
          <CommandField label="打开网页" value={openUrl} onChange={setOpenUrl} button="发送到手机" disabled={!connected} onSubmit={() => sendCommand("device.open_url", { url: openUrl })} />
          <CommandField label="朗读或复制文本" value={text} onChange={setText} button="朗读" disabled={!connected} onSubmit={() => sendCommand("device.speak", { text })} secondaryButton="复制" onSecondary={() => sendCommand("device.copy_text", { text })} />
          <CommandField label="打开快捷指令" value={shortcutName} onChange={setShortcutName} button="打开" disabled={!connected || !shortcutName.trim()} onSubmit={() => sendCommand("shortcut.open", { name: shortcutName })} placeholder="快捷指令名称" />
        </section>

        <section className="deviceCard activityCard">
          <div className="cardTitle"><div><span>04</span><h2>审批与审计</h2></div><button className="textButton" type="button" onClick={() => setLogs([])}>清空</button></div>
          <div className="activityList">
            {logs.length === 0 ? <p className="emptyActivity">还没有控制事件。</p> : logs.map((log) => (
              <article key={log.id} className={log.tone}>
                <time>{new Date(log.at).toLocaleTimeString()}</time>
                <span>{log.message}</span>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function CommandField({ label, value, onChange, button, disabled, onSubmit, secondaryButton, onSecondary, placeholder }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  button: string;
  disabled: boolean;
  onSubmit: () => void;
  secondaryButton?: string;
  onSecondary?: () => void;
  placeholder?: string;
}) {
  return (
    <label className="commandField">
      <span>{label}</span>
      <div>
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
        <button type="button" disabled={disabled || !value.trim()} onClick={onSubmit}>{button}</button>
        {secondaryButton && onSecondary ? <button className="secondaryButton" type="button" disabled={disabled || !value.trim()} onClick={onSecondary}>{secondaryButton}</button> : null}
      </div>
    </label>
  );
}

function StatusDot({ active, label }: { active: boolean; label: string }) {
  return <span className={`connectionState ${active ? "active" : ""}`}><i />{label}</span>;
}

async function responseError(response: Response) {
  try {
    const payload = await response.json() as { detail?: string };
    return payload.detail || `请求失败 (${response.status})`;
  } catch {
    return `请求失败 (${response.status})`;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "未知错误";
}

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function auditTone(event: DeviceAuditEvent): ControlLog["tone"] {
  if (event.ok === false || event.event.includes("failed")) return "error";
  if (event.event.includes("revoked") || event.event.includes("expired") || event.event.includes("approval")) return "warning";
  if (event.event.includes("connected") || event.ok === true) return "success";
  return "info";
}

function auditLabel(event: DeviceAuditEvent) {
  const action = event.action ? ` · ${event.action}` : "";
  const result = typeof event.ok === "boolean" ? ` · ${event.ok ? "成功" : "失败"}` : "";
  const labels: Record<string, string> = {
    pairing_created: "已创建配对",
    pairing_claimed: "iPhone 已认领配对",
    pairing_expired: "配对已过期",
    pairing_revoked: "配对已撤销",
    controller_connected: "控制台已连接",
    controller_disconnected: "控制台已断开",
    device_connected: "iPhone 已连接",
    device_disconnected: "iPhone 已断开",
    command_sent: "已发送命令",
    command_delivery_failed: "命令投递失败",
    command_result: "命令执行结果",
    approval_result: "手机审批结果"
  };
  return `${labels[event.event] ?? event.event}${action}${result}`;
}
