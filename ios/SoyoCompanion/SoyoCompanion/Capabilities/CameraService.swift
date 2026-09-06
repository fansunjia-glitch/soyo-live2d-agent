import AVFoundation
import Foundation
import SwiftUI
import UIKit

struct CameraPresentation: Identifiable, Equatable {
    let id: UUID
}

@MainActor
final class CameraCaptureService: ObservableObject {
    @Published private(set) var presentation: CameraPresentation?
    private var continuation: (operation: UUID, value: CheckedContinuation<UIImage?, Never>)?
    private var activeOperation: UUID?
    private var busy = false

    func captureJPEGDataURL() async throws -> String {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            throw CapabilityError.unavailable("相机")
        }
        guard !busy else { throw CapabilityError.busy("相机") }
        let operation = UUID()
        activeOperation = operation
        busy = true
        defer {
            if activeOperation == operation {
                activeOperation = nil
                busy = false
                presentation = nil
            }
        }

        guard try await requestPermission() else { throw CapabilityError.permissionDenied("相机") }
        try Task.checkCancellation()
        guard activeOperation == operation else { throw CapabilityError.cancelled("拍照") }

        let image = await withCheckedContinuation { continuation in
            self.continuation = (operation, continuation)
            presentation = CameraPresentation(id: operation)
        }
        try Task.checkCancellation()
        guard activeOperation == operation else { throw CapabilityError.cancelled("拍照") }
        guard let image else { throw CapabilityError.cancelled("拍照") }
        guard let data = Self.compactJPEG(image) else {
            throw CapabilityError.executionFailed("无法压缩照片。")
        }
        return DeviceProtocol.jpegDataURLPrefix + data.base64EncodedString()
    }

    func complete(operation: UUID, with image: UIImage?) {
        guard activeOperation == operation,
              let continuation,
              continuation.operation == operation else { return }
        self.continuation = nil
        presentation = nil
        continuation.value.resume(returning: image)
    }

    func cancel() {
        activeOperation = nil
        busy = false
        presentation = nil
        let pending = continuation
        continuation = nil
        pending?.value.resume(returning: nil)
    }

    private func requestPermission() async throws -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .denied, .restricted: return false
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .video) { allowed in
                    continuation.resume(returning: allowed)
                }
            }
        @unknown default: return false
        }
    }

    private static func compactJPEG(_ image: UIImage) -> Data? {
        let maximumEdge: CGFloat = 960
        let sourceSize = image.size
        let scale = min(1, maximumEdge / max(sourceSize.width, sourceSize.height))
        let targetSize = CGSize(
            width: max(1, floor(sourceSize.width * scale)),
            height: max(1, floor(sourceSize.height * scale))
        )
        let renderer = UIGraphicsImageRenderer(size: targetSize)
        let resized = renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: targetSize)) }

        for quality in stride(from: CGFloat(0.68), through: CGFloat(0.28), by: CGFloat(-0.1)) {
            if let data = resized.jpegData(compressionQuality: quality),
               data.count <= DeviceProtocol.maximumJPEGBytes {
                return data
            }
        }
        return nil
    }
}

struct SystemCameraPicker: UIViewControllerRepresentable {
    let operation: UUID
    let onComplete: (UUID, UIImage?) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(operation: operation, onComplete: onComplete)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = .camera
        controller.cameraCaptureMode = .photo
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    static func dismantleUIViewController(_ uiViewController: UIImagePickerController, coordinator: Coordinator) {
        coordinator.finish(with: nil)
    }

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        private let operation: UUID
        private let onComplete: (UUID, UIImage?) -> Void
        private var completed = false

        init(operation: UUID, onComplete: @escaping (UUID, UIImage?) -> Void) {
            self.operation = operation
            self.onComplete = onComplete
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            finish(with: nil)
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            finish(with: info[.originalImage] as? UIImage)
        }

        func finish(with image: UIImage?) {
            guard !completed else { return }
            completed = true
            onComplete(operation, image)
        }
    }
}
