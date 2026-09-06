import Foundation
import UIKit

extension DeviceDescriptor {
    @MainActor
    static func current(capabilities: [DeviceAction]) -> DeviceDescriptor {
        let device = UIDevice.current
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        return DeviceDescriptor(
            name: device.name,
            model: device.model,
            systemName: device.systemName,
            systemVersion: device.systemVersion,
            appVersion: version,
            capabilities: capabilities.map(\.rawValue).sorted()
        )
    }
}
