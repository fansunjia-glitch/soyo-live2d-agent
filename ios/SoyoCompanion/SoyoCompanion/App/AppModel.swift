import Foundation
import SwiftUI

struct PendingApproval: Identifiable, Equatable {
    let id: String
    let title: String
    let action: String
    let summary: String
    let expiresAt: Date
}

@MainActor
final class AppModel: ObservableObject {
    @Published var serverAddress: String
    @Published var pairingCode = ""
    @Published private(set) var credentials: DeviceCredentials?
    @Published private(set) var connectionState: DeviceConnectionState = .disconnected
    @Published private(set) var controllerConnected = false
    @Published private(set) var isPairing = false
    @Published var lastError: String?
    @Published private(set) var pendingApproval: PendingApproval?

    let audit: AuditStore
    let capabilities: CapabilityRegistry

    private let keychain: KeychainStore
    private let pairingAPI: PairingAPI
    private let socket: DeviceWebSocketClient
    private let validator = CommandValidator()
    private var ledger = CommandLedger()
    private var commandQueue: [DeviceCommand] = []
    private var commandProcessor: Task<Void, Never>?
    private var commandProcessorGeneration = UUID()
    private var frameSendTask: Task<Void, Never>?
    private var pendingFrameDataURL: String?
    private var frameSendGeneration = UUID()
    private var approvalContinuation: CheckedContinuation<Bool, Never>?
    private var approvalTimeout: Task<Void, Never>?
    private var hasStarted = false
    private var wasBackgrounded = false

    init(
        audit: AuditStore = AuditStore(),
        capabilities: CapabilityRegistry = CapabilityRegistry(),
        keychain: KeychainStore = KeychainStore(),
        pairingAPI: PairingAPI = PairingAPI(),
        socket: DeviceWebSocketClient = DeviceWebSocketClient()
    ) {
        self.audit = audit
        self.capabilities = capabilities
        self.keychain = keychain
        self.pairingAPI = pairingAPI
        self.socket = socket
        self.serverAddress = UserDefaults.standard.string(forKey: "soyo.companion.server-url") ?? "https://"

        socket.onStateChange = { [weak self] state in
            guard let self else { return }
            self.connectionState = state
            if !state.isConnected {
                self.controllerConnected = false
                self.cancelControllerWorkAndCapture()
            }
        }
        socket.onMessage = { [weak self] message in self?.receive(message) }
        socket.onTransportError = { [weak self] error in
            guard let self else { return }
            self.lastError = error.localizedDescription
            self.audit.record("transport_error", summary: "控制通道中断，等待安全重连。", severity: .warning)
        }
        socket.onCredentialsRejected = { [weak self] in
            self?.forgetPairing(reason: "服务端拒绝或已过期的设备凭据已从本机删除。")
        }
        socket.onConnectionReplaced = { [weak self] in
            guard let self else { return }
            self.lastError = "另一个伴生端连接已接管当前配对；已停止自动重连。"
            self.audit.record("connection_replaced", summary: "另一个伴生端接管了配对，等待用户手动重连。", severity: .warning)
        }
        capabilities.replayKit.onFrame = { [weak self] dataURL in
            self?.enqueueScreenFrame(dataURL)
        }
        capabilities.replayKit.onFailure = { [weak self] error in
            guard let self else { return }
            self.lastError = error.localizedDescription
            self.audit.record("screen_share_error", summary: "ReplayKit 捕获失败。", severity: .error)
            self.stopReplayKitCaptureIfActive()
        }
    }

    var descriptor: DeviceDescriptor {
        DeviceDescriptor.current(capabilities: capabilities.actions)
    }

    func start() {
        guard !hasStarted else { return }
        hasStarted = true
        do {
            if let saved = try keychain.load() {
                credentials = saved
                serverAddress = saved.serverURL.absoluteString
                socket.connect(saved)
                audit.record("credentials_restored", summary: "已从 Keychain 恢复设备配对。")
            }
        } catch {
            lastError = error.localizedDescription
            audit.record("keychain_error", summary: "无法读取本地配对信息。", severity: .error)
        }
    }

    func pair() async {
        guard !isPairing else { return }
        isPairing = true
        lastError = nil
        defer { isPairing = false }

        do {
            let claimed = try await pairingAPI.claim(
                serverURL: serverAddress,
                code: pairingCode,
                device: descriptor
            )
            try keychain.save(claimed)
            credentials = claimed
            pairingCode = ""
            serverAddress = claimed.serverURL.absoluteString
            UserDefaults.standard.set(serverAddress, forKey: "soyo.companion.server-url")
            audit.record("paired", summary: "已安全配对并把设备令牌保存到 Keychain。", severity: .success)
            socket.connect(claimed)
        } catch {
            lastError = error.localizedDescription
            audit.record("pairing_failed", summary: "设备配对失败。", severity: .error)
        }
    }

    func reconnect() {
        guard credentials != nil else { return }
        lastError = nil
        socket.reconnectNow()
    }

    func becameActive() {
        guard wasBackgrounded else { return }
        wasBackgrounded = false
        guard credentials != nil else { return }
        socket.reconnectNow()
    }

    func enteredBackground() {
        wasBackgrounded = true
        if pendingApproval != nil { resolveApproval(allowed: false) }
        capabilities.cancelPendingWork()
    }

    func forgetPairing(reason: String = "用户已在手机上忘记配对。") {
        resolveApproval(allowed: false)
        capabilities.cancelPendingWork()
        commandProcessorGeneration = UUID()
        commandProcessor?.cancel()
        commandProcessor = nil
        commandQueue = []
        cancelFrameDelivery()
        ledger.reset()
        socket.disconnect(forgetCredentials: true)
        credentials = nil
        controllerConnected = false
        do {
            try keychain.delete()
            audit.record("pairing_forgotten", summary: reason, severity: .warning)
        } catch {
            lastError = error.localizedDescription
            audit.record("keychain_error", summary: "配对已断开，但 Keychain 清理失败。", severity: .error)
        }
        stopReplayKitCaptureIfActive()
    }

    func resolveApproval(allowed: Bool) {
        guard let continuation = approvalContinuation else { return }
        approvalContinuation = nil
        approvalTimeout?.cancel()
        approvalTimeout = nil
        pendingApproval = nil
        continuation.resume(returning: allowed)
    }

    func stopScreenSharing() async {
        cancelFrameDelivery()
        do {
            try await capabilities.replayKit.stop()
            audit.record("screen_share_stopped", summary: "屏幕共享已在手机上停止。", severity: .success)
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func enqueueScreenFrame(_ dataURL: String) {
        guard connectionState.isConnected, controllerConnected else { return }
        // Backpressure is deliberately latest-only: at most one large frame is
        // in flight and one is retained while a weak uplink catches up.
        pendingFrameDataURL = dataURL
        guard frameSendTask == nil else { return }
        let generation = UUID()
        frameSendGeneration = generation
        frameSendTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled, self.connectionState.isConnected,
                  let next = self.pendingFrameDataURL {
                self.pendingFrameDataURL = nil
                guard let frame = try? OutgoingMessage.screenFrame(dataURL: next) else {
                    self.audit.record("screen_frame_rejected", summary: "画面帧格式无效或超过服务端消息上限。", severity: .error)
                    continue
                }
                do {
                    try await self.socket.send(frame)
                } catch {
                    break
                }
            }
            if self.frameSendGeneration == generation {
                self.frameSendTask = nil
            }
        }
    }

    private func cancelFrameDelivery() {
        frameSendGeneration = UUID()
        frameSendTask?.cancel()
        frameSendTask = nil
        pendingFrameDataURL = nil
    }

    private func receive(_ message: IncomingMessage) {
        switch message.type {
        case "device_session":
            do {
                guard let credentials else { throw ProtocolError.deviceSessionIdentityMismatch }
                let session = try DeviceSession(message: message, credentials: credentials)
                socket.confirmAuthenticated()
                controllerConnected = session.controllerConnected
                if !controllerConnected { cancelControllerWorkAndCapture() }
                audit.record("socket_authenticated", summary: "设备控制通道已认证。", severity: .success)
                Task {
                    try? await socket.send(.hello(descriptor))
                    try? await socket.send(.state(descriptor, connected: true))
                }
            } catch {
                rejectDeviceSession(error)
            }

        case "controller_state":
            controllerConnected = message.connected ?? false
            if !controllerConnected {
                cancelControllerWorkAndCapture()
            }
            audit.record(
                "controller_state",
                summary: controllerConnected ? "网页控制端已连接。" : "网页控制端已离线。",
                severity: controllerConnected ? .success : .warning
            )

        case "command":
            do {
                guard connectionState.isConnected, controllerConnected else { throw SocketError.notConnected }
                enqueue(try DeviceCommand(message: message))
            } catch {
                lastError = error.localizedDescription
                audit.record("invalid_command", summary: "收到格式无效的命令。", severity: .error)
            }

        case "pairing_revoked":
            audit.record("pairing_revoked", summary: "控制端已撤销配对。", severity: .warning)
            forgetPairing(reason: "控制端已撤销配对，本地凭据已删除。")

        case "error":
            lastError = message.error ?? "服务端返回未知错误。"
            audit.record("server_error", summary: "服务端拒绝了设备消息。", severity: .error)

        case "ping":
            Task { try? await socket.send(.pong()) }

        default:
            break
        }
    }

    private func rejectDeviceSession(_ error: Error) {
        controllerConnected = false
        lastError = error.localizedDescription
        audit.record("device_session_rejected", summary: "服务端设备会话与本地配对不一致，连接已关闭。", severity: .error)
        socket.disconnect()
    }

    private func cancelControllerWorkAndCapture() {
        if pendingApproval != nil { resolveApproval(allowed: false) }
        capabilities.cancelPendingWork()
        commandProcessorGeneration = UUID()
        commandProcessor?.cancel()
        commandProcessor = nil
        commandQueue = []
        cancelFrameDelivery()
        stopReplayKitCaptureIfActive()
    }

    private func stopReplayKitCaptureIfActive() {
        guard let operation = capabilities.replayKit.activeOperation else { return }
        Task { try? await capabilities.replayKit.stop(ifCurrent: operation) }
    }

    private func enqueue(_ command: DeviceCommand) {
        guard commandQueue.count < 50 else {
            let outcome = CommandOutcome(ok: false, message: "手机命令队列已满。", data: nil)
            Task { try? await socket.send(.commandResult(command: command, outcome: outcome)) }
            audit.record("queue_full", summary: "命令队列已满，拒绝新命令。", severity: .error)
            return
        }
        commandQueue.append(command)
        guard commandProcessor == nil else { return }
        let generation = UUID()
        commandProcessorGeneration = generation
        commandProcessor = Task { [weak self] in
            guard let self else { return }
            await self.drainCommandQueue(generation: generation)
        }
    }

    private func drainCommandQueue(generation: UUID) async {
        defer {
            if commandProcessorGeneration == generation {
                commandProcessor = nil
            }
        }
        while commandProcessorGeneration == generation, !Task.isCancelled, !commandQueue.isEmpty {
            let command = commandQueue.removeFirst()
            await process(command)
        }
    }

    private func process(_ command: DeviceCommand) async {
        let validated: ValidatedCommand
        do {
            validated = try validator.validate(command)
            switch try ledger.begin(validated) {
            case .duplicate(let outcome):
                try? await socket.send(.commandResult(command: command, outcome: outcome))
                audit.record("command_duplicate", summary: "重复命令已返回缓存结果：\(command.actionName)。", severity: .warning)
                return
            case .execute:
                break
            }
        } catch {
            let outcome = CommandOutcome(ok: false, message: error.localizedDescription, data: nil)
            try? await socket.send(.commandResult(command: command, outcome: outcome))
            audit.record("command_rejected", summary: "安全校验拒绝命令：\(command.actionName)。", severity: .error)
            return
        }

        guard let action = command.action else {
            await complete(command, outcome: .init(ok: false, message: "手机不支持该能力。", data: nil))
            return
        }
        let capability = capabilities.descriptor(for: action)
        let needsApproval = capability.requiresLocalApproval || command.serverRequiresApproval
        if needsApproval {
            let summary = capabilities.approvalSummary(for: command)
            try? await socket.send(.approvalRequired(command: command, summary: summary))
            let allowed = await requestApproval(
                command: command,
                capability: capability,
                summary: summary,
                expiresAt: validated.expiresAt
            )
            guard !Task.isCancelled else { return }
            try? await socket.send(.approvalResult(command: command, allowed: allowed))
            guard allowed else {
                await complete(command, outcome: .init(ok: false, message: "用户拒绝或审批已超时。", data: nil))
                return
            }
            do {
                _ = try validator.validate(command)
            } catch {
                await complete(command, outcome: .init(ok: false, message: "命令在审批期间已经过期。", data: nil))
                return
            }
        }

        audit.record("command_started", summary: "开始执行：\(capability.title)。")
        do {
            let execution = try await capabilities.execute(command)
            guard !Task.isCancelled else { return }
            await complete(command, outcome: .init(ok: true, message: execution.message, data: execution.data))
        } catch {
            guard !Task.isCancelled else { return }
            await complete(command, outcome: .init(ok: false, message: error.localizedDescription, data: nil))
        }
    }

    private func complete(_ command: DeviceCommand, outcome: CommandOutcome) async {
        ledger.complete(commandId: command.id, outcome: outcome)
        try? await socket.send(.commandResult(command: command, outcome: outcome))
        audit.record(
            outcome.ok ? "command_completed" : "command_failed",
            summary: "\(command.actionName)：\(outcome.ok ? "完成" : "失败")。",
            severity: outcome.ok ? .success : .error
        )
    }

    private func requestApproval(
        command: DeviceCommand,
        capability: CapabilityDescriptor,
        summary: String,
        expiresAt: Int64
    ) async -> Bool {
        guard approvalContinuation == nil else { return false }
        let remainingMilliseconds = max(0, expiresAt - Int64.nowMilliseconds)
        pendingApproval = PendingApproval(
            id: command.id,
            title: capability.title,
            action: command.actionName,
            summary: summary,
            expiresAt: Date(timeIntervalSince1970: Double(expiresAt) / 1_000)
        )
        audit.record("approval_required", summary: "等待本机审批：\(capability.title)。", severity: .warning)

        return await withCheckedContinuation { continuation in
            approvalContinuation = continuation
            approvalTimeout = Task { [weak self] in
                do {
                    try await Task.sleep(for: .milliseconds(remainingMilliseconds))
                } catch {
                    return
                }
                guard let self else { return }
                self.resolveApproval(allowed: false)
            }
        }
    }
}
