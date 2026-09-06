import SwiftUI

struct PairingView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 8) {
                        Image(systemName: "iphone.gen3.radiowaves.left.and.right")
                            .font(.system(size: 42, weight: .semibold))
                            .foregroundStyle(.teal)
                        Text("连接 Soyo")
                            .font(.largeTitle.bold())
                        Text("输入网页控制台生成的一次性配对码。令牌只保存到这台 iPhone 的 Keychain。")
                            .foregroundStyle(.secondary)
                    }

                    VStack(alignment: .leading, spacing: 16) {
                        LabeledContent("服务端根地址") {
                            TextField("https://soyo.example.com", text: $model.serverAddress)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.URL)
                                .multilineTextAlignment(.trailing)
                        }
                        Divider()
                        LabeledContent("六位配对码") {
                            TextField("000000", text: $model.pairingCode)
                                .keyboardType(.numberPad)
                                .multilineTextAlignment(.trailing)
                                .font(.system(.title3, design: .monospaced).weight(.semibold))
                                .onChange(of: model.pairingCode) { _, value in
                                    model.pairingCode = String(value.filter(\.isNumber).prefix(6))
                                }
                        }
                    }
                    .padding()
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18))

                    if let error = model.lastError {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .padding()
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                    }

                    Button {
                        Task { await model.pair() }
                    } label: {
                        HStack {
                            if model.isPairing { ProgressView().tint(.white) }
                            Text(model.isPairing ? "正在安全配对…" : "配对这台 iPhone")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.teal)
                    .disabled(model.isPairing || model.pairingCode.count != 6)

                    Label("敏感命令必须在手机上逐次确认；服务端不能关闭这项保护。", systemImage: "hand.raised.fill")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(24)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Soyo Companion")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
