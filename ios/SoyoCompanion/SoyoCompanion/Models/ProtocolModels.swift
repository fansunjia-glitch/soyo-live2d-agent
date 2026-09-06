import Foundation

enum DeviceProtocol {
    static let currentVersion = 1
    static let maximumCommandTTL: Int64 = 30_000
    static let maximumFutureClockSkew: Int64 = 15_000
    static let maximumMessageBytes = 2_000_000
    static let maximumJPEGBytes = 1_250_000
    static let jpegDataURLPrefix = "data:image/jpeg;base64,"
}

enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var stringValue: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

    var boolValue: Bool? {
        guard case .bool(let value) = self else { return nil }
        return value
    }

    var numberValue: Double? {
        guard case .number(let value) = self else { return nil }
        return value
    }
}

enum DeviceAction: String, Codable, CaseIterable, Sendable {
    case ping = "agent.ping"
    case info = "device.info"
    case openURL = "device.open_url"
    case copyText = "device.copy_text"
    case locationOnce = "device.location_once"
    case speak = "device.speak"
    case cameraCapture = "camera.capture"
    case screenShareStart = "screen_share.start"
    case screenShareStop = "screen_share.stop"
    case shortcutOpen = "shortcut.open"

    var requiresApprovalByProtocol: Bool {
        switch self {
        case .ping, .info, .screenShareStop:
            return false
        default:
            return true
        }
    }

    static var approvalPolicy: [String: Bool] {
        Dictionary(uniqueKeysWithValues: allCases.map { ($0.rawValue, $0.requiresApprovalByProtocol) })
    }
}

struct DeviceDescriptor: Codable, Equatable, Sendable {
    let name: String
    let model: String
    let systemName: String
    let systemVersion: String
    let appVersion: String
    let capabilities: [String]
}

struct DeviceCredentials: Codable, Equatable, Sendable {
    let serverURL: URL
    let pairingId: String
    let deviceId: String
    let deviceToken: String
    let pairedAt: Date
}

struct PairingClaimRequest: Encodable {
    let pairingCode: String
    let name: String
    let model: String
    let systemName: String
    let systemVersion: String
    let appVersion: String
    let capabilities: [String]

    init(code: String, device: DeviceDescriptor) {
        pairingCode = code
        name = device.name
        model = device.model
        systemName = device.systemName
        systemVersion = device.systemVersion
        appVersion = device.appVersion
        capabilities = device.capabilities
    }
}

struct PairingClaimResponse: Decodable {
    let pairingId: String
    let deviceId: String
    let deviceToken: String
    let controllerConnected: Bool
}

struct AuthenticationMessage: Encodable {
    let type = "authenticate"
    let schemaVersion = DeviceProtocol.currentVersion
    let pairingId: String
    let deviceId: String
    let token: String
}

struct IncomingMessage: Decodable {
    let type: String
    let schemaVersion: Int?
    let pairingId: String?
    let deviceId: String?
    let approvalPolicy: [String: Bool]?
    let id: String?
    let action: String?
    let params: [String: JSONValue]?
    let requiresApproval: Bool?
    let issuedAt: Int64?
    let expiresAt: Int64?
    let nonce: String?
    let error: String?
    let connected: Bool?
    let controllerConnected: Bool?
}

struct DeviceSession: Equatable, Sendable {
    let schemaVersion: Int
    let pairingId: String
    let deviceId: String
    let approvalPolicy: [String: Bool]
    let controllerConnected: Bool

    init(message: IncomingMessage, credentials: DeviceCredentials) throws {
        guard message.type == "device_session" else { throw ProtocolError.notADeviceSession }
        guard let schemaVersion = message.schemaVersion,
              let pairingId = message.pairingId, !pairingId.isEmpty,
              let deviceId = message.deviceId, !deviceId.isEmpty,
              let approvalPolicy = message.approvalPolicy,
              let controllerConnected = message.controllerConnected else {
            throw ProtocolError.missingDeviceSessionField
        }
        guard schemaVersion == DeviceProtocol.currentVersion else {
            throw ProtocolError.unsupportedSchemaVersion(schemaVersion)
        }
        guard pairingId == credentials.pairingId, deviceId == credentials.deviceId else {
            throw ProtocolError.deviceSessionIdentityMismatch
        }
        guard approvalPolicy == DeviceAction.approvalPolicy else {
            throw ProtocolError.approvalPolicyMismatch
        }

        self.schemaVersion = schemaVersion
        self.pairingId = pairingId
        self.deviceId = deviceId
        self.approvalPolicy = approvalPolicy
        self.controllerConnected = controllerConnected
    }
}

struct DeviceCommand: Equatable, Sendable {
    let schemaVersion: Int
    let id: String
    let actionName: String
    let params: [String: JSONValue]
    let serverRequiresApproval: Bool
    let issuedAt: Int64
    let expiresAt: Int64
    let nonce: String

    init(
        schemaVersion: Int = DeviceProtocol.currentVersion,
        id: String,
        actionName: String,
        params: [String: JSONValue] = [:],
        serverRequiresApproval: Bool = true,
        issuedAt: Int64,
        expiresAt: Int64,
        nonce: String
    ) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.actionName = actionName
        self.params = params
        self.serverRequiresApproval = serverRequiresApproval
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.nonce = nonce
    }

    init(message: IncomingMessage) throws {
        guard message.type == "command" else { throw ProtocolError.notACommand }
        guard let schemaVersion = message.schemaVersion,
              let id = message.id, !id.isEmpty,
              let action = message.action, !action.isEmpty,
              let params = message.params,
              let requiresApproval = message.requiresApproval,
              let issuedAt = message.issuedAt,
              let expiresAt = message.expiresAt,
              let nonce = message.nonce else {
            throw ProtocolError.missingCommandField
        }
        self.schemaVersion = schemaVersion
        self.id = id
        self.actionName = action
        self.params = params
        self.serverRequiresApproval = requiresApproval
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.nonce = nonce
    }

    var action: DeviceAction? { DeviceAction(rawValue: actionName) }
}

struct CommandOutcome: Codable, Equatable, Sendable {
    let ok: Bool
    let message: String
    let data: [String: JSONValue]?
}

struct OutgoingMessage: Encodable, Sendable {
    let type: String
    var schemaVersion = DeviceProtocol.currentVersion
    var id: String?
    var action: String?
    var ok: Bool?
    var message: String?
    var data: [String: JSONValue]?
    var device: DeviceDescriptor?
    var capabilities: [String]?
    var connected: Bool?
    var requiresApproval: Bool?
    var dataUrl: String?
    var at: Int64 = .nowMilliseconds

    static func hello(_ descriptor: DeviceDescriptor) -> OutgoingMessage {
        OutgoingMessage(
            type: "device_hello",
            device: descriptor,
            capabilities: descriptor.capabilities,
            connected: true
        )
    }

    static func state(_ descriptor: DeviceDescriptor, connected: Bool) -> OutgoingMessage {
        OutgoingMessage(type: "device_state", device: descriptor, connected: connected)
    }

    static func commandResult(command: DeviceCommand, outcome: CommandOutcome) -> OutgoingMessage {
        OutgoingMessage(
            type: "command_result",
            id: command.id,
            action: command.actionName,
            ok: outcome.ok,
            message: outcome.message,
            data: outcome.data
        )
    }

    static func approvalRequired(command: DeviceCommand, summary: String) -> OutgoingMessage {
        OutgoingMessage(
            type: "approval_required",
            id: command.id,
            action: command.actionName,
            message: summary,
            requiresApproval: true
        )
    }

    static func approvalResult(command: DeviceCommand, allowed: Bool) -> OutgoingMessage {
        OutgoingMessage(
            type: "approval_result",
            id: command.id,
            action: command.actionName,
            ok: allowed,
            message: allowed ? "用户已允许" : "用户已拒绝"
        )
    }

    static func screenFrame(dataURL: String) throws -> OutgoingMessage {
        guard dataURL.hasPrefix(DeviceProtocol.jpegDataURLPrefix) else {
            throw ProtocolError.invalidScreenFrame
        }
        let message = OutgoingMessage(type: "screen_frame", dataUrl: dataURL)
        guard try JSONEncoder().encode(message).count <= DeviceProtocol.maximumMessageBytes else {
            throw ProtocolError.messageTooLarge
        }
        return message
    }

    static func pong() -> OutgoingMessage {
        OutgoingMessage(type: "pong", ok: true)
    }
}

enum ProtocolError: LocalizedError {
    case notACommand
    case notADeviceSession
    case missingCommandField
    case missingDeviceSessionField
    case unsupportedSchemaVersion(Int)
    case deviceSessionIdentityMismatch
    case approvalPolicyMismatch
    case invalidScreenFrame
    case invalidMessage
    case messageTooLarge

    var errorDescription: String? {
        switch self {
        case .notACommand: return "消息不是命令。"
        case .notADeviceSession: return "消息不是设备会话。"
        case .missingCommandField: return "命令缺少 schemaVersion、id、action、params、requiresApproval、issuedAt、expiresAt 或 nonce。"
        case .missingDeviceSessionField: return "设备会话缺少必要字段。"
        case .unsupportedSchemaVersion(let version): return "不支持协议版本 \(version)。"
        case .deviceSessionIdentityMismatch: return "设备会话身份与本地配对凭据不一致。"
        case .approvalPolicyMismatch: return "服务端审批策略与协议 v1 不一致。"
        case .invalidScreenFrame: return "屏幕帧必须是 JPEG data URL。"
        case .invalidMessage: return "服务端消息无法解析。"
        case .messageTooLarge: return "消息超过允许大小。"
        }
    }
}

extension Int64 {
    static var nowMilliseconds: Int64 { Int64(Date().timeIntervalSince1970 * 1_000) }
}
