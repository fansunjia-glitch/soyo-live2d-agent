import SwiftUI

struct AuditView: View {
    @ObservedObject var audit: AuditStore
    @State private var confirmClear = false

    var body: some View {
        NavigationStack {
            List {
                if audit.entries.isEmpty {
                    ContentUnavailableView("暂无审计事件", systemImage: "list.bullet.rectangle")
                } else {
                    ForEach(audit.entries) { entry in
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: icon(for: entry.severity))
                                .foregroundStyle(color(for: entry.severity))
                                .frame(width: 22)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(entry.summary)
                                HStack {
                                    Text(entry.event).font(.caption.monospaced())
                                    Text(entry.date, format: .dateTime.month().day().hour().minute().second())
                                }
                                .foregroundStyle(.secondary)
                                .font(.caption)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
            .navigationTitle("本机审计")
            .toolbar {
                Button("清空") { confirmClear = true }
                    .disabled(audit.entries.isEmpty)
            }
            .confirmationDialog("清空本机审计？", isPresented: $confirmClear) {
                Button("清空", role: .destructive) { audit.clear() }
                Button("取消", role: .cancel) {}
            }
        }
    }

    private func icon(for severity: AuditSeverity) -> String {
        switch severity {
        case .info: return "info.circle.fill"
        case .success: return "checkmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .error: return "xmark.octagon.fill"
        }
    }

    private func color(for severity: AuditSeverity) -> Color {
        switch severity {
        case .info: return .blue
        case .success: return .green
        case .warning: return .orange
        case .error: return .red
        }
    }
}
