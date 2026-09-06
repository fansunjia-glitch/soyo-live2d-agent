import Combine
import Foundation

enum AuditSeverity: String, Codable, Sendable {
    case info
    case success
    case warning
    case error
}

struct AuditEntry: Identifiable, Codable, Equatable, Sendable {
    let id: UUID
    let date: Date
    let severity: AuditSeverity
    let event: String
    let summary: String
}

@MainActor
final class AuditStore: ObservableObject {
    @Published private(set) var entries: [AuditEntry] = []

    private let storageKey = "soyo.companion.audit.v1"
    private let maximumEntries = 200

    init() {
        if let data = UserDefaults.standard.data(forKey: storageKey),
           let decoded = try? JSONDecoder().decode([AuditEntry].self, from: data) {
            entries = Array(decoded.prefix(maximumEntries))
        }
    }

    func record(_ event: String, summary: String, severity: AuditSeverity = .info) {
        let entry = AuditEntry(id: UUID(), date: Date(), severity: severity, event: event, summary: summary)
        entries.insert(entry, at: 0)
        if entries.count > maximumEntries {
            entries.removeLast(entries.count - maximumEntries)
        }
        persist()
    }

    func clear() {
        entries = []
        UserDefaults.standard.removeObject(forKey: storageKey)
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(entries) else { return }
        UserDefaults.standard.set(data, forKey: storageKey)
    }
}
