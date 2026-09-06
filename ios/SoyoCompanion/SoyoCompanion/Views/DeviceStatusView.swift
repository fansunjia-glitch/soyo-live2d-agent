import SwiftUI

struct DeviceStatusView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var replayKit: ReplayKitStreamer
    @State private var confirmForget = false

    var body: some View {
        NavigationStack {
            List {
                Section("连接") {
                    StatusRow(
                        title: "伴生端",
                        value: model.connectionState.label,
                        active: model.connectionState.isConnected
                    )
                    StatusRow(
                        title: "网页控制端",
                        value: model.controllerConnected ? "在线" : "未连接",
                        active: model.controllerConnected
                    )
                    if let credentials = model.credentials {
                        LabeledContent("服务端", value: credentials.serverURL.host ?? credentials.serverURL.absoluteString)
                        LabeledContent("设备 ID", value: String(credentials.deviceId.prefix(8)) + "…")
                    }
                }

                Section("ReplayKit") {
                    LabeledContent("状态", value: replayKit.state.label)
                    if replayKit.state != .stopped {
                        Button("在手机上停止共享", role: .destructive) {
                            Task { await model.stopScreenSharing() }
                        }
                    }
                    Text("画面以低帧率压缩后发送。iOS 的录制提示和状态不会被隐藏。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if let error = model.lastError {
                    Section("最近错误") {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button("立即重连") { model.reconnect() }
                        .disabled(model.connectionState.isConnected)
                    Button("忘记此配对", role: .destructive) { confirmForget = true }
                } footer: {
                    Text("忘记配对会删除本机 Keychain 凭据。若需服务端彻底撤销，也请在网页控制台点击“撤销并断开”。")
                }
            }
            .navigationTitle("Soyo 设备端")
            .confirmationDialog("忘记此配对？", isPresented: $confirmForget, titleVisibility: .visible) {
                Button("忘记并断开", role: .destructive) { model.forgetPairing() }
                Button("取消", role: .cancel) {}
            }
        }
    }
}

private struct StatusRow: View {
    let title: String
    let value: String
    let active: Bool

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            Circle()
                .fill(active ? Color.green : Color.secondary.opacity(0.4))
                .frame(width: 8, height: 8)
            Text(value).foregroundStyle(.secondary)
        }
    }
}
