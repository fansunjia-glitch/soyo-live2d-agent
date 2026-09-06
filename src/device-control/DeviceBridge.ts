import { wsUrl } from "../api";
import {
  DEVICE_ACTIONS,
  clearStoredPairing,
  readStoredPairing,
  storePairing,
  type AgentDeviceRequest,
  type DeviceAction,
  type DeviceBridgeSnapshot,
  type DeviceInfo,
  type DeviceToolResult,
  type PairingCredentials
} from "./types";

type PendingCommand = {
  action: DeviceAction;
  resolve: (result: DeviceToolResult) => void;
  reject: (error: Error) => void;
  timeout: number;
};

const initialSnapshot: DeviceBridgeSnapshot = {
  state: "unpaired",
  paired: false,
  authenticated: false,
  deviceConnected: false,
  capabilities: []
};

/** Authenticated browser-side controller used by the conversation tool loop. */
export class DeviceBridge {
  onState?: (snapshot: DeviceBridgeSnapshot) => void;
  onScreenFrame?: (dataUrl: string) => void;
  onPerceptionSignal?: (signal: unknown) => void;
  onApproval?: (value: { id: string; action: string; required: boolean; ok?: boolean }) => void;

  private socket: WebSocket | null = null;
  private credentials: PairingCredentials | null = null;
  private snapshotValue: DeviceBridgeSnapshot = initialSnapshot;
  private pending = new Map<string, PendingCommand>();
  private reconnectTimer: number | null = null;
  private generation = 0;
  private retry = 0;
  private desired = false;

  get snapshot(): DeviceBridgeSnapshot {
    return { ...this.snapshotValue, capabilities: [...this.snapshotValue.capabilities] };
  }

  connect(credentials = readStoredPairing()): void {
    this.desired = true;
    this.credentials = credentials;
    if (!credentials || credentials.expiresAt <= Date.now()) {
      if (credentials) clearStoredPairing(credentials.pairingId);
      this.stopSocket();
      this.publish({ ...initialSnapshot, state: credentials ? "expired" : "unpaired" });
      return;
    }
    this.open(credentials);
  }

  disconnect(): void {
    this.desired = false;
    this.credentials = null;
    this.stopSocket();
    this.rejectPending(new Error("iPhone 控制通道已断开。"));
    this.onScreenFrame?.("");
    this.publish(initialSnapshot);
  }

  async execute(request: AgentDeviceRequest, signal?: AbortSignal): Promise<DeviceToolResult> {
    const normalized = normalizeDeviceRequest(request);
    if (!normalized) throw new Error("模型生成了无效的 iPhone 动作请求。")
    const socket = this.socket;
    const snapshot = this.snapshotValue;
    if (!socket || socket.readyState !== WebSocket.OPEN || !snapshot.authenticated) {
      throw new Error("iPhone 控制通道尚未认证，请先完成配对。")
    }
    if (!snapshot.deviceConnected) throw new Error("已配对的 iPhone 当前不在线。")
    if (!["agent.ping", "device.info"].includes(normalized.action)
      && !snapshot.capabilities.includes(normalized.action)) {
      throw new Error(`iPhone 未声明能力：${normalized.action}`);
    }

    const id = createId();
    return new Promise<DeviceToolResult>((resolve, reject) => {
      const settleReject = (error: Error) => {
        const current = this.pending.get(id);
        if (!current) return;
        window.clearTimeout(current.timeout);
        this.pending.delete(id);
        signal?.removeEventListener("abort", abortHandler);
        reject(error);
      };
      const abortHandler = () => settleReject(new Error("iPhone 动作已取消。"));
      const timeout = window.setTimeout(() => settleReject(new Error("等待 iPhone 执行结果超时。")), 5 * 60_000);
      this.pending.set(id, {
        action: normalized.action,
        timeout,
        resolve: (result) => {
          signal?.removeEventListener("abort", abortHandler);
          resolve(result);
        },
        reject
      });
      signal?.addEventListener("abort", abortHandler, { once: true });
      if (signal?.aborted) {
        abortHandler();
        return;
      }
      try {
        socket.send(JSON.stringify({
          type: "command",
          schemaVersion: 1,
          id,
          action: normalized.action,
          params: normalized.params
        }));
      } catch (error) {
        settleReject(toError(error));
      }
    });
  }

  private open(credentials: PairingCredentials): void {
    this.stopSocket();
    const pairingId = credentials.pairingId;
    const attempt = ++this.generation;
    this.publish({
      ...this.snapshotValue,
      state: this.retry > 0 ? "reconnecting" : "connecting",
      paired: true,
      authenticated: false,
      deviceConnected: false,
      error: undefined
    });
    const socket = new WebSocket(wsUrl("/ws/device-control/controller"));
    this.socket = socket;
    socket.onopen = () => {
      if (!this.current(socket, attempt)) return;
      const currentCredentials = this.credentials;
      if (!currentCredentials || currentCredentials.pairingId !== pairingId) {
        socket.close(4003, "pairing credentials changed");
        return;
      }
      socket.send(JSON.stringify({
        type: "authenticate",
        schemaVersion: 1,
        pairingId: currentCredentials.pairingId,
        token: currentCredentials.controllerToken
      }));
    };
    socket.onmessage = (event) => {
      if (!this.current(socket, attempt)) return;
      try {
        this.handle(JSON.parse(String(event.data)) as Record<string, unknown>, pairingId);
      } catch (error) {
        this.publish({ ...this.snapshotValue, error: toError(error).message });
      }
    };
    socket.onerror = () => {
      if (this.current(socket, attempt)) this.publish({ ...this.snapshotValue, error: "iPhone 控制通道连接失败。" });
    };
    socket.onclose = (event) => {
      if (!this.current(socket, attempt)) return;
      this.socket = null;
      this.rejectPending(new Error("iPhone 控制通道在动作完成前断开。"));
      this.onScreenFrame?.("");
      if (event.code === 4003 || event.code === 4401) {
        clearStoredPairing(pairingId);
        if (this.credentials?.pairingId === pairingId) this.credentials = null;
        this.desired = false;
        this.publish({ ...initialSnapshot, error: "iPhone 控制凭据已失效。" });
        return;
      }
      if (event.code === 4009) {
        this.desired = false;
        this.publish({
          ...this.snapshotValue,
          state: "replaced",
          authenticated: false,
          deviceConnected: false,
          error: "另一个控制端已接管配对；可在当前页面手动重新连接。"
        });
        return;
      }
      const currentCredentials = this.credentials;
      if (this.desired && currentCredentials?.pairingId === pairingId && Date.now() < currentCredentials.expiresAt) {
        this.scheduleReconnect(pairingId);
      } else {
        this.publish({ ...this.snapshotValue, state: "expired", authenticated: false, deviceConnected: false });
      }
    };
  }

  private handle(payload: Record<string, unknown>, pairingId: string): void {
    const type = typeof payload.type === "string" ? payload.type : "";
    if (type === "pairing_status") {
      if (payload.schemaVersion !== 1 || payload.pairingId !== pairingId) {
        this.socket?.close(4400, "pairing identity mismatch");
        throw new Error("控制通道返回了不匹配的配对身份。")
      }
      const state = payload.state;
      const expiresAt = parsePairingExpiresAt(payload.expiresAt);
      if (!["waiting", "paired", "expired", "revoked"].includes(String(state)) || expiresAt === null) {
        this.socket?.close(4400, "invalid pairing status");
        throw new Error("控制通道返回了无效的配对状态。")
      }
      if (state === "expired" || state === "revoked" || expiresAt <= Date.now()) {
        this.socket?.close(4003, "pairing expired");
        return;
      }
      const currentCredentials = this.credentials;
      if (!currentCredentials || currentCredentials.pairingId !== pairingId) {
        this.socket?.close(4400, "pairing identity mismatch");
        throw new Error("本地配对凭据已发生变化。")
      }
      const refreshedCredentials = { ...currentCredentials, expiresAt };
      this.credentials = refreshedCredentials;
      try {
        storePairing(refreshedCredentials);
      } catch {
        this.socket?.close(4400, "pairing storage unavailable");
        throw new Error("无法安全保存更新后的配对凭据。")
      }
      this.retry = 0;
      this.publish({
        ...this.snapshotValue,
        state: "connected",
        paired: true,
        authenticated: true,
        deviceConnected: payload.deviceConnected === true,
        device: parseDeviceInfo(payload.device),
        capabilities: parseCapabilities(payload.device)
      });
      return;
    }
    if (!this.snapshotValue.authenticated) throw new Error("控制通道在认证前发送了业务消息。")
    if (type === "device_state" || type === "device_hello") {
      const device = parseDeviceInfo(payload.device) ?? this.snapshotValue.device;
      const connected = payload.connected === true;
      this.publish({
        ...this.snapshotValue,
        deviceConnected: connected,
        device,
        capabilities: device ? device.capabilities.filter(isDeviceAction) : this.snapshotValue.capabilities
      });
      if (!connected) {
        this.rejectPending(new Error("iPhone 在动作完成前离线。"));
        this.onScreenFrame?.("");
      }
      return;
    }
    if (type === "screen_frame") {
      const dataUrl = typeof payload.dataUrl === "string" ? payload.dataUrl : "";
      if (validImageDataUrl(dataUrl)) this.onScreenFrame?.(dataUrl);
      return;
    }
    if (type === "event") {
      this.onPerceptionSignal?.(payload.event ?? payload);
      return;
    }
    if (type === "approval_required" || type === "approval_result") {
      this.onApproval?.({
        id: String(payload.id ?? ""),
        action: String(payload.action ?? ""),
        required: type === "approval_required",
        ...(type === "approval_result" ? { ok: payload.ok === true } : {})
      });
      return;
    }
    if (type === "command_result") this.finishCommand(payload);
    if (type === "pairing_revoked") this.socket?.close(4003, "pairing revoked");
    if (type === "error") {
      const message = typeof payload.error === "string" ? payload.error : "设备控制服务拒绝了请求。";
      const id = typeof payload.id === "string" ? payload.id : "";
      const pending = id ? this.pending.get(id) : this.pending.size === 1 ? [...this.pending.values()][0] : undefined;
      if (pending) {
        const pendingId = id || [...this.pending].find(([, value]) => value === pending)?.[0] || "";
        window.clearTimeout(pending.timeout);
        this.pending.delete(pendingId);
        pending.reject(new Error(message.slice(0, 500)));
      }
      this.publish({ ...this.snapshotValue, error: message.slice(0, 500) });
    }
  }

  private finishCommand(payload: Record<string, unknown>): void {
    const id = typeof payload.id === "string" ? payload.id : "";
    const command = this.pending.get(id);
    if (!command) return;
    const result = sanitizeToolResult(command.action, payload);
    window.clearTimeout(command.timeout);
    this.pending.delete(id);
    if (!result) {
      command.reject(new Error("iPhone 返回了无效的动作结果。"));
      return;
    }
    command.resolve(result);
  }

  private scheduleReconnect(pairingId: string): void {
    const delay = Math.min(30_000, 1_500 * (2 ** Math.min(this.retry++, 4)));
    this.publish({ ...this.snapshotValue, state: "reconnecting", authenticated: false, deviceConnected: false });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      const currentCredentials = this.credentials;
      if (this.desired && currentCredentials?.pairingId === pairingId && Date.now() < currentCredentials.expiresAt) {
        this.open(currentCredentials);
      } else if (this.desired) {
        this.publish({ ...this.snapshotValue, state: "expired", authenticated: false, deviceConnected: false });
      }
    }, delay);
  }

  private stopSocket(): void {
    this.generation += 1;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
  }

  private current(socket: WebSocket, generation: number): boolean {
    return this.socket === socket && this.generation === generation;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private publish(snapshot: DeviceBridgeSnapshot): void {
    this.snapshotValue = snapshot;
    this.onState?.(this.snapshot);
  }
}

export function normalizeDeviceRequest(value: unknown): AgentDeviceRequest | null {
  if (!record(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Object.keys(raw).every((key) => ["action", "params", "reason"].includes(key))
    || !isDeviceAction(raw.action) || !record(raw.params)
    || typeof raw.reason !== "string" || !raw.reason.trim() || raw.reason.length > 160) return null;
  const params = normalizeActionParams(raw.action, raw.params as Record<string, unknown>);
  return params ? { action: raw.action, params, reason: raw.reason.trim() } : null;
}

function normalizeActionParams(action: DeviceAction, params: Record<string, unknown>): Record<string, unknown> | null {
  if (action === "device.open_url") {
    if (!exactKeys(params, ["url"]) || typeof params.url !== "string" || params.url.length > 2_048) return null;
    try {
      const url = new URL(params.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    } catch { return null; }
    return { url: params.url };
  }
  if (action === "device.copy_text" || action === "device.speak") {
    const maximum = action === "device.speak" ? 2_000 : 4_000;
    return exactKeys(params, ["text"]) && typeof params.text === "string"
      && params.text.trim() && params.text.length <= maximum ? { text: params.text } : null;
  }
  if (action === "shortcut.open") {
    return exactKeys(params, ["name"]) && typeof params.name === "string"
      && params.name.trim() && params.name.length <= 128 && !/[\r\n]/.test(params.name)
      ? { name: params.name.trim() } : null;
  }
  if (action === "screen_share.start") {
    if (!Object.keys(params).every((key) => ["includeMicrophone", "framesPerSecond"].includes(key))) return null;
    if (params.includeMicrophone !== undefined && typeof params.includeMicrophone !== "boolean") return null;
    if (params.includeMicrophone === true) return null;
    if (params.framesPerSecond !== undefined && (typeof params.framesPerSecond !== "number"
      || !Number.isFinite(params.framesPerSecond) || params.framesPerSecond < 0.5 || params.framesPerSecond > 2)) return null;
    return {
      includeMicrophone: false,
      ...(params.framesPerSecond === undefined ? {} : { framesPerSecond: params.framesPerSecond })
    };
  }
  return Object.keys(params).length === 0 ? {} : null;
}

function sanitizeToolResult(action: DeviceAction, payload: Record<string, unknown>): DeviceToolResult | null {
  if (payload.action !== action || typeof payload.ok !== "boolean") return null;
  const message = typeof payload.message === "string" ? payload.message.slice(0, 500) : "";
  const rawData = record(payload.data) ? payload.data as Record<string, unknown> : {};
  const data: Record<string, unknown> = {};
  let imageDataUrl: string | undefined;
  if (action === "camera.capture") {
    const candidate = typeof rawData.imageDataUrl === "string" ? rawData.imageDataUrl : "";
    if (candidate && validImageDataUrl(candidate)) imageDataUrl = candidate;
  } else if (action === "device.location_once") {
    for (const key of ["latitude", "longitude", "horizontalAccuracy", "timestamp"] as const) {
      if (typeof rawData[key] === "number" && Number.isFinite(rawData[key])) data[key] = rawData[key];
    }
  } else if (action === "device.info") {
    for (const key of ["name", "model", "systemName", "systemVersion", "appVersion"] as const) {
      if (typeof rawData[key] === "string") data[key] = rawData[key].slice(0, 100);
    }
    if (Array.isArray(rawData.capabilities)) data.capabilities = rawData.capabilities.filter(isDeviceAction);
  }
  return { action, ok: payload.ok, message, data, ...(imageDataUrl ? { imageDataUrl } : {}) };
}

function parseDeviceInfo(value: unknown): DeviceInfo | undefined {
  if (!record(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const fields = ["name", "model", "systemName", "systemVersion", "appVersion"] as const;
  if (fields.some((field) => typeof raw[field] !== "string")) return undefined;
  return {
    name: String(raw.name).slice(0, 100),
    model: String(raw.model).slice(0, 100),
    systemName: String(raw.systemName).slice(0, 40),
    systemVersion: String(raw.systemVersion).slice(0, 40),
    appVersion: String(raw.appVersion).slice(0, 40),
    capabilities: Array.isArray(raw.capabilities)
      ? raw.capabilities.filter((item): item is string => typeof item === "string").slice(0, 50)
      : []
  };
}

function parseCapabilities(value: unknown): DeviceAction[] {
  return parseDeviceInfo(value)?.capabilities.filter(isDeviceAction) ?? [];
}

function validImageDataUrl(value: string): boolean {
  return value.length <= 2_000_000 && /^data:image\/(jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function parsePairingExpiresAt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function isDeviceAction(value: unknown): value is DeviceAction {
  return typeof value === "string" && (DEVICE_ACTIONS as readonly string[]).includes(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
