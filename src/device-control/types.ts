export type DeviceInfo = {
  name: string;
  model: string;
  systemName: string;
  systemVersion: string;
  appVersion: string;
  capabilities: string[];
};

export type PairingCredentials = {
  pairingId: string;
  pairingCode: string;
  controllerToken: string;
  expiresAt: number;
};

export const pairingStorageKey = "soyo.device-control.pairing.v1";

export const DEVICE_ACTIONS = [
  "agent.ping",
  "device.info",
  "device.open_url",
  "device.copy_text",
  "device.location_once",
  "device.speak",
  "camera.capture",
  "screen_share.start",
  "screen_share.stop",
  "shortcut.open"
] as const;

export type DeviceAction = typeof DEVICE_ACTIONS[number];

export type AgentDeviceRequest = {
  action: DeviceAction;
  params: Record<string, unknown>;
  reason: string;
};

export type DeviceToolResult = {
  action: DeviceAction;
  ok: boolean;
  message: string;
  data: Record<string, unknown>;
  imageDataUrl?: string;
};

export type DeviceBridgeSnapshot = {
  state: "unpaired" | "connecting" | "connected" | "reconnecting" | "replaced" | "expired";
  paired: boolean;
  authenticated: boolean;
  deviceConnected: boolean;
  capabilities: DeviceAction[];
  device?: DeviceInfo;
  error?: string;
};

export function readStoredPairing(): PairingCredentials | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const raw = sessionStorage.getItem(pairingStorageKey);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PairingCredentials>;
    if (typeof value.pairingId !== "string" || !value.pairingId
      || typeof value.controllerToken !== "string" || !value.controllerToken
      || typeof value.pairingCode !== "string"
      || typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return null;
    return value as PairingCredentials;
  } catch {
    return null;
  }
}

export function storePairing(credentials: PairingCredentials): void {
  sessionStorage.setItem(pairingStorageKey, JSON.stringify(credentials));
}

export function clearStoredPairing(expectedPairingId?: string): void {
  const current = readStoredPairing();
  if (expectedPairingId && current?.pairingId !== expectedPairingId) return;
  try { sessionStorage.removeItem(pairingStorageKey); } catch { /* unavailable storage */ }
}

export type PairingStatus = {
  schemaVersion?: number;
  pairingId: string;
  state: "waiting" | "paired" | "expired" | "revoked";
  expiresAt: number;
  deviceId?: string;
  device?: DeviceInfo;
  deviceConnected: boolean;
  controllerConnected: boolean;
};

export type DeviceAuditEvent = {
  event: string;
  at: number;
  commandId?: string;
  action?: string;
  ok?: boolean;
  requiresApproval?: boolean;
};

export type ControlLog = {
  id: string;
  at: number;
  tone: "info" | "success" | "warning" | "error";
  message: string;
};
