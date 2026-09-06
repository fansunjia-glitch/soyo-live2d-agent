import SwiftUI

@main
struct SoyoCompanionApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView(
                model: model,
                audit: model.audit,
                camera: model.capabilities.camera,
                replayKit: model.capabilities.replayKit
            )
            .task { model.start() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { model.becameActive() }
                if phase == .background { model.enteredBackground() }
            }
        }
    }
}
