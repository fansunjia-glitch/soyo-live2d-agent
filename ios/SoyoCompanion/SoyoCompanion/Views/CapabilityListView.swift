import SwiftUI

struct CapabilityListView: View {
    @ObservedObject var replayKit: ReplayKitStreamer

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(CapabilityRegistry.descriptors) { capability in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(capability.title).fontWeight(.semibold)
                                Spacer()
                                Text(capability.requiresLocalApproval ? "逐次审批" : "自动")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(capability.requiresLocalApproval ? .orange : .green)
                            }
                            Text(capability.explanation)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            Text(capability.action.rawValue)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 3)
                    }
                } header: {
                    Text("本机能力注册表")
                } footer: {
                    Text("服务端只能调用这里列出的 action。系统相机、位置、麦克风和 ReplayKit 权限仍由 iOS 独立控制。当前共享状态：\(replayKit.state.label)。")
                }
            }
            .navigationTitle("能力与权限")
        }
    }
}
