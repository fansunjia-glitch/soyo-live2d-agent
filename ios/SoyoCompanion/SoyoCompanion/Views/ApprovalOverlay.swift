import SwiftUI

struct ApprovalOverlay: View {
    let approval: PendingApproval
    let resolve: (Bool) -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.52).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 18) {
                Label("需要你的确认", systemImage: "hand.raised.fill")
                    .font(.headline)
                    .foregroundStyle(.orange)
                Text(approval.title)
                    .font(.title2.bold())
                Text(approval.summary)
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Text(approval.action).font(.caption.monospaced())
                    Text("此请求将在 \(approval.expiresAt.formatted(date: .omitted, time: .standard)) 失效")
                        .font(.caption)
                }
                .foregroundStyle(.secondary)
                HStack {
                    Button("拒绝", role: .destructive) { resolve(false) }
                        .buttonStyle(.bordered)
                        .frame(maxWidth: .infinity)
                    Button("仅允许这一次") { resolve(true) }
                        .buttonStyle(.borderedProminent)
                        .tint(.teal)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(24)
            .frame(maxWidth: 440)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24))
            .padding(20)
            .accessibilityAddTraits(.isModal)
        }
    }
}
