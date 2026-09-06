import Foundation

enum DeviceConnectionState: Equatable {
    case disconnected
    case connecting
    case connected
    case waitingToReconnect(seconds: Int)

    var label: String {
        switch self {
        case .disconnected: return "未连接"
        case .connecting: return "连接中"
        case .connected: return "已连接"
        case .waitingToReconnect(let seconds): return "\(seconds) 秒后重连"
        }
    }

    var isConnected: Bool { self == .connected }
}

@MainActor
final class DeviceWebSocketClient {
    var onStateChange: ((DeviceConnectionState) -> Void)?
    var onMessage: ((IncomingMessage) -> Void)?
    var onTransportError: ((Error) -> Void)?
    var onCredentialsRejected: (() -> Void)?
    var onConnectionReplaced: (() -> Void)?

    private var state: DeviceConnectionState = .disconnected {
        didSet {
            guard state != oldValue else { return }
            onStateChange?(state)
        }
    }
    private var desiredCredentials: DeviceCredentials?
    private var socketTask: URLSessionWebSocketTask?
    private var session: URLSession?
    private var receiveTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var authenticationTimeoutTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var generation = UUID()
    private var retryCount = 0
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    func connect(_ credentials: DeviceCredentials) {
        desiredCredentials = credentials
        retryCount = 0
        open(credentials)
    }

    func reconnectNow() {
        guard let credentials = desiredCredentials else { return }
        retryCount = 0
        open(credentials)
    }

    func disconnect(forgetCredentials: Bool = false) {
        generation = UUID()
        receiveTask?.cancel()
        heartbeatTask?.cancel()
        authenticationTimeoutTask?.cancel()
        reconnectTask?.cancel()
        receiveTask = nil
        heartbeatTask = nil
        authenticationTimeoutTask = nil
        reconnectTask = nil
        socketTask?.cancel(with: .normalClosure, reason: nil)
        socketTask = nil
        session?.invalidateAndCancel()
        session = nil
        if forgetCredentials { desiredCredentials = nil }
        state = .disconnected
    }

    func send(_ message: OutgoingMessage) async throws {
        guard let socketTask, state == .connected else { throw SocketError.notConnected }
        let data = try encoder.encode(message)
        guard data.count <= DeviceProtocol.maximumMessageBytes else { throw ProtocolError.messageTooLarge }
        guard let text = String(data: data, encoding: .utf8) else { throw ProtocolError.invalidMessage }
        try await socketTask.send(.string(text))
    }

    /// Authentication is complete only after AppModel has validated the
    /// server's signed-by-possession `device_session` envelope.
    func confirmAuthenticated() {
        guard state == .connecting, let socketTask else { return }
        authenticationTimeoutTask?.cancel()
        authenticationTimeoutTask = nil
        state = .connected
        startHeartbeat(socketTask: socketTask, attempt: generation)
    }

    private func open(_ credentials: DeviceCredentials) {
        disconnect()
        desiredCredentials = credentials
        let attempt = UUID()
        generation = attempt
        state = .connecting

        do {
            let url = try ServerAddress.webSocketURL(for: credentials)
            let configuration = URLSessionConfiguration.ephemeral
            configuration.waitsForConnectivity = true
            configuration.timeoutIntervalForRequest = 25
            let session = URLSession(configuration: configuration)
            let socketTask = session.webSocketTask(with: url)
            self.session = session
            self.socketTask = socketTask
            socketTask.resume()

            receiveTask = Task { [weak self] in
                guard let self else { return }
                do {
                    let authentication = AuthenticationMessage(
                        pairingId: credentials.pairingId,
                        deviceId: credentials.deviceId,
                        token: credentials.deviceToken
                    )
                    let authData = try self.encoder.encode(authentication)
                    guard let authText = String(data: authData, encoding: .utf8) else {
                        throw ProtocolError.invalidMessage
                    }
                    try await socketTask.send(.string(authText))
                    guard self.generation == attempt else { return }
                    self.startAuthenticationTimeout(socketTask: socketTask, attempt: attempt)
                    try await self.receiveLoop(socketTask: socketTask, attempt: attempt)
                } catch is CancellationError {
                    return
                } catch {
                    guard self.generation == attempt else { return }
                    self.onTransportError?(error)
                    if Self.isCredentialRejection(socketTask.closeCode) {
                        self.stopAfterCredentialRejection(attempt: attempt)
                    } else if socketTask.closeCode.rawValue == 4009 {
                        self.stopAfterReplacement(attempt: attempt)
                    } else {
                        self.scheduleReconnect(afterFailureOf: attempt)
                    }
                }
            }
        } catch {
            onTransportError?(error)
            scheduleReconnect(afterFailureOf: attempt)
        }
    }

    private func receiveLoop(socketTask: URLSessionWebSocketTask, attempt: UUID) async throws {
        while !Task.isCancelled, generation == attempt {
            let message = try await socketTask.receive()
            guard generation == attempt, !Task.isCancelled else { return }
            let data: Data
            switch message {
            case .string(let text): data = Data(text.utf8)
            case .data(let value): data = value
            @unknown default: throw ProtocolError.invalidMessage
            }
            guard data.count <= DeviceProtocol.maximumMessageBytes else { throw ProtocolError.messageTooLarge }
            let decoded = try decoder.decode(IncomingMessage.self, from: data)
            onMessage?(decoded)
        }
    }

    private func scheduleReconnect(afterFailureOf attempt: UUID) {
        guard generation == attempt, desiredCredentials != nil else { return }
        heartbeatTask?.cancel()
        heartbeatTask = nil
        authenticationTimeoutTask?.cancel()
        authenticationTimeoutTask = nil
        socketTask?.cancel(with: .goingAway, reason: nil)
        socketTask = nil
        session?.invalidateAndCancel()
        session = nil

        retryCount += 1
        let seconds = min(30, max(1, Int(pow(2, Double(min(retryCount - 1, 5))))))
        state = .waitingToReconnect(seconds: seconds)
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(seconds))
            } catch {
                return
            }
            guard let self, self.generation == attempt, let credentials = self.desiredCredentials else { return }
            self.open(credentials)
        }
    }

    private func startAuthenticationTimeout(socketTask: URLSessionWebSocketTask, attempt: UUID) {
        authenticationTimeoutTask?.cancel()
        authenticationTimeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(15))
            } catch {
                return
            }
            guard let self, self.generation == attempt, self.state == .connecting else { return }
            self.onTransportError?(SocketError.authenticationTimedOut)
            socketTask.cancel(with: .policyViolation, reason: Data("authentication timeout".utf8))
        }
    }

    private func stopAfterCredentialRejection(attempt: UUID) {
        guard generation == attempt else { return }
        desiredCredentials = nil
        disconnect(forgetCredentials: true)
        onCredentialsRejected?()
    }

    private func stopAfterReplacement(attempt: UUID) {
        guard generation == attempt else { return }
        disconnect()
        onConnectionReplaced?()
    }

    private static func isCredentialRejection(_ code: URLSessionWebSocketTask.CloseCode) -> Bool {
        code.rawValue == 4003 || code.rawValue == 4401
    }

    private func startHeartbeat(socketTask: URLSessionWebSocketTask, attempt: UUID) {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(20))
                    guard let self, self.generation == attempt else { return }
                    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                        socketTask.sendPing { error in
                            if let error { continuation.resume(throwing: error) }
                            else { continuation.resume(returning: ()) }
                        }
                    }
                    self.retryCount = 0
                } catch is CancellationError {
                    return
                } catch {
                    guard let self, self.generation == attempt else { return }
                    self.onTransportError?(error)
                    socketTask.cancel(with: .goingAway, reason: nil)
                    return
                }
            }
        }
    }
}

enum SocketError: LocalizedError {
    case notConnected
    case authenticationTimedOut

    var errorDescription: String? {
        switch self {
        case .notConnected: return "设备控制通道尚未连接。"
        case .authenticationTimedOut: return "设备控制通道认证超时。"
        }
    }
}
