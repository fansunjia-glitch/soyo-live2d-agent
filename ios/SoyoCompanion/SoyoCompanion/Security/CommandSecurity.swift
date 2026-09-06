import Foundation

struct ValidatedCommand: Equatable, Sendable {
    let command: DeviceCommand
    let nonce: String
    let expiresAt: Int64
}

struct CommandValidator {
    func validate(_ command: DeviceCommand, nowMilliseconds: Int64 = .nowMilliseconds) throws -> ValidatedCommand {
        guard command.schemaVersion == DeviceProtocol.currentVersion else {
            throw CommandSecurityError.unsupportedProtocol(command.schemaVersion)
        }
        guard !command.id.isEmpty, command.id.utf8.count <= 128 else {
            throw CommandSecurityError.invalidCommandId
        }
        guard !command.actionName.isEmpty, command.actionName.utf8.count <= 128 else {
            throw CommandSecurityError.invalidAction
        }
        guard let action = command.action else {
            throw CommandSecurityError.invalidAction
        }
        guard command.serverRequiresApproval == action.requiresApprovalByProtocol else {
            throw CommandSecurityError.approvalRequirementMismatch
        }
        guard command.issuedAt <= nowMilliseconds + DeviceProtocol.maximumFutureClockSkew else {
            throw CommandSecurityError.issuedInFuture
        }

        let (lifetime, overflow) = command.expiresAt.subtractingReportingOverflow(command.issuedAt)
        guard !overflow, lifetime > 0, lifetime <= DeviceProtocol.maximumCommandTTL else {
            throw CommandSecurityError.invalidTTL
        }
        guard nowMilliseconds <= command.expiresAt else {
            throw CommandSecurityError.expired
        }

        guard !command.nonce.isEmpty, command.nonce.utf8.count <= 160 else {
            throw CommandSecurityError.invalidNonce
        }
        return ValidatedCommand(command: command, nonce: command.nonce, expiresAt: command.expiresAt)
    }
}

enum LedgerDecision: Equatable, Sendable {
    case execute
    case duplicate(CommandOutcome)
}

struct CommandLedger {
    private struct Entry: Sendable {
        let nonce: String
        var outcome: CommandOutcome?
        let retainUntil: Int64
    }

    private var commands: [String: Entry] = [:]
    private var nonceOwners: [String: String] = [:]
    private let retentionMilliseconds: Int64 = 15 * 60 * 1_000
    private let maximumEntries = 512

    mutating func begin(
        _ validated: ValidatedCommand,
        nowMilliseconds: Int64 = .nowMilliseconds
    ) throws -> LedgerDecision {
        purge(nowMilliseconds: nowMilliseconds)

        if let existing = commands[validated.command.id] {
            guard existing.nonce == validated.nonce else {
                throw CommandSecurityError.commandIdCollision
            }
            if let outcome = existing.outcome { return .duplicate(outcome) }
            throw CommandSecurityError.commandAlreadyRunning
        }
        if let owner = nonceOwners[validated.nonce], owner != validated.command.id {
            throw CommandSecurityError.nonceReplay
        }

        commands[validated.command.id] = Entry(
            nonce: validated.nonce,
            outcome: nil,
            retainUntil: max(validated.expiresAt, nowMilliseconds) + retentionMilliseconds
        )
        nonceOwners[validated.nonce] = validated.command.id
        trimIfNeeded()
        return .execute
    }

    mutating func complete(commandId: String, outcome: CommandOutcome) {
        guard var entry = commands[commandId] else { return }
        entry.outcome = outcome
        commands[commandId] = entry
    }

    mutating func reset() {
        commands = [:]
        nonceOwners = [:]
    }

    private mutating func purge(nowMilliseconds: Int64) {
        let expiredIds = commands.compactMap { key, value in
            value.retainUntil < nowMilliseconds ? key : nil
        }
        for id in expiredIds {
            if let entry = commands.removeValue(forKey: id) {
                nonceOwners.removeValue(forKey: entry.nonce)
            }
        }
    }

    private mutating func trimIfNeeded() {
        guard commands.count > maximumEntries else { return }
        let overflow = commands.count - maximumEntries
        let oldest = commands.sorted { $0.value.retainUntil < $1.value.retainUntil }.prefix(overflow)
        for (id, entry) in oldest {
            commands.removeValue(forKey: id)
            nonceOwners.removeValue(forKey: entry.nonce)
        }
    }
}

enum CommandSecurityError: LocalizedError, Equatable {
    case unsupportedProtocol(Int)
    case invalidCommandId
    case invalidAction
    case approvalRequirementMismatch
    case issuedInFuture
    case invalidTTL
    case expired
    case invalidNonce
    case nonceReplay
    case commandIdCollision
    case commandAlreadyRunning

    var errorDescription: String? {
        switch self {
        case .unsupportedProtocol(let version): return "不支持命令协议版本 \(version)。"
        case .invalidCommandId: return "命令 ID 无效。"
        case .invalidAction: return "命令 action 无效。"
        case .approvalRequirementMismatch: return "命令审批要求与协议 v1 策略不一致。"
        case .issuedInFuture: return "命令签发时间超出允许的时钟偏差。"
        case .invalidTTL: return "命令 TTL 无效或过长。"
        case .expired: return "命令已经过期。"
        case .invalidNonce: return "命令 nonce 无效。"
        case .nonceReplay: return "检测到 nonce 重放。"
        case .commandIdCollision: return "相同命令 ID 使用了不同 nonce。"
        case .commandAlreadyRunning: return "相同命令仍在执行。"
        }
    }
}
