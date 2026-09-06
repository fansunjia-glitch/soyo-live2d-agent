import SwiftUI

struct RootView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var audit: AuditStore
    @ObservedObject var camera: CameraCaptureService
    @ObservedObject var replayKit: ReplayKitStreamer

    var body: some View {
        ZStack {
            Group {
                if model.credentials == nil {
                    PairingView(model: model)
                } else {
                    TabView {
                        DeviceStatusView(model: model, replayKit: replayKit)
                            .tabItem { Label("状态", systemImage: "iphone.gen3.radiowaves.left.and.right") }
                        CapabilityListView(replayKit: replayKit)
                            .tabItem { Label("能力", systemImage: "checkmark.shield") }
                        AuditView(audit: audit)
                            .tabItem { Label("审计", systemImage: "list.bullet.rectangle") }
                    }
                    .tint(.teal)
                }
            }
            .allowsHitTesting(model.pendingApproval == nil)

            if let approval = model.pendingApproval {
                ApprovalOverlay(approval: approval) { allowed in
                    model.resolveApproval(allowed: allowed)
                }
                .transition(.opacity.combined(with: .scale(scale: 0.97)))
                .zIndex(10)
            }
        }
        .animation(.easeInOut(duration: 0.18), value: model.pendingApproval?.id)
        .fullScreenCover(item: Binding(
            get: { camera.presentation },
            set: { _ in }
        )) { presentation in
            SystemCameraPicker(operation: presentation.id) { operation, image in
                camera.complete(operation: operation, with: image)
            }
                .ignoresSafeArea()
        }
    }
}
