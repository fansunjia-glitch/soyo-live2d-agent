import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceBridge, normalizeDeviceRequest } from "./DeviceBridge";
import { pairingStorageKey, type PairingCredentials } from "./types";

const sockets: FakeWebSocket[] = [];

class FakeWebSocket {
  static readonly OPEN = 1;

  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;

  constructor(readonly url: string) {
    sockets.push(this);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(undefined as unknown as Event);
  }

  receive(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  disconnect(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  sockets.length = 0;
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  });
  vi.stubGlobal("window", {
    location: { protocol: "http:", host: "localhost" },
    setTimeout,
    clearTimeout
  });
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DeviceBridge pairing lifetime", () => {
  it("persists a server-extended expiry and uses it for reconnect", async () => {
    const credentials: PairingCredentials = {
      pairingId: "pairing-1",
      pairingCode: "123456",
      controllerToken: "controller-token",
      expiresAt: 1_100
    };
    const bridge = new DeviceBridge();

    bridge.connect(credentials);
    sockets[0].open();
    sockets[0].receive({
      type: "pairing_status",
      schemaVersion: 1,
      pairingId: credentials.pairingId,
      state: "paired",
      expiresAt: 10_000,
      deviceConnected: false
    });

    expect(JSON.parse(sessionStorage.getItem(pairingStorageKey) ?? "{}").expiresAt).toBe(10_000);
    vi.setSystemTime(2_000);
    sockets[0].disconnect();
    expect(bridge.snapshot.state).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(1_500);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(JSON.parse(sockets[1].sent[0])).toMatchObject({
      pairingId: credentials.pairingId,
      token: credentials.controllerToken
    });
  });

  it("rejects a pairing status with a non-integer expiry", () => {
    const credentials: PairingCredentials = {
      pairingId: "pairing-2",
      pairingCode: "654321",
      controllerToken: "controller-token",
      expiresAt: 10_000
    };
    const bridge = new DeviceBridge();

    bridge.connect(credentials);
    sockets[0].open();
    sockets[0].receive({
      type: "pairing_status",
      schemaVersion: 1,
      pairingId: credentials.pairingId,
      state: "paired",
      expiresAt: 10_000.5,
      deviceConnected: false
    });

    expect(sockets[0].closedWith?.code).toBe(4400);
    expect(sessionStorage.getItem(pairingStorageKey)).toBeNull();
    expect(bridge.snapshot.error).toContain("无效的配对状态");
  });

  it("rejects an in-flight command as soon as the paired phone goes offline", async () => {
    const credentials: PairingCredentials = {
      pairingId: "pairing-3",
      pairingCode: "112233",
      controllerToken: "controller-token",
      expiresAt: 10_000
    };
    const bridge = new DeviceBridge();
    bridge.connect(credentials);
    sockets[0].open();
    sockets[0].receive({
      type: "pairing_status",
      schemaVersion: 1,
      pairingId: credentials.pairingId,
      state: "paired",
      expiresAt: 10_000,
      deviceConnected: true
    });

    const result = bridge.execute({ action: "agent.ping", params: {}, reason: "确认手机在线" });
    sockets[0].receive({ type: "device_state", connected: false });

    await expect(result).rejects.toThrow("离线");
  });
});

describe("DeviceBridge screen sharing policy", () => {
  it("fails closed on microphone capture and emits an explicit false otherwise", () => {
    expect(normalizeDeviceRequest({
      action: "screen_share.start",
      params: { includeMicrophone: true },
      reason: "共享屏幕"
    })).toBeNull();
    expect(normalizeDeviceRequest({
      action: "screen_share.start",
      params: { framesPerSecond: 1 },
      reason: "共享屏幕"
    })?.params).toEqual({ includeMicrophone: false, framesPerSecond: 1 });
  });
});
