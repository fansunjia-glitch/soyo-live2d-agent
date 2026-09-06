import Combine
import CoreImage
import CoreMedia
import Foundation
import ReplayKit
import UIKit

@MainActor
final class ReplayKitStreamer: ObservableObject {
    enum State: Equatable {
        case stopped
        case starting
        case streaming
        case stopping

        var label: String {
            switch self {
            case .stopped: return "未共享"
            case .starting: return "启动中"
            case .streaming: return "共享中"
            case .stopping: return "停止中"
            }
        }
    }

    @Published private(set) var state: State = .stopped
    var onFrame: ((String) -> Void)?
    var onFailure: ((Error) -> Void)?

    private let recorder = RPScreenRecorder.shared()
    private let encoder = ReplayFrameEncoder()
    private var operation = UUID()
    private var activeStartAttempt: UUID?
    private var startSettlements: [UUID: Bool] = [:]
    private var startSettlementWaiters: [(UUID, CheckedContinuation<Bool, Never>)] = []
    private var stopTask: Task<Void, Error>?
    private var stopGeneration = UUID()

    var activeOperation: UUID? {
        state == .stopped ? nil : operation
    }

    func start(includeMicrophone: Bool, framesPerSecond: Double = 1.25) async throws {
        guard state == .stopped else { throw CapabilityError.busy("屏幕共享") }
        guard recorder.isAvailable else { throw CapabilityError.unavailable("ReplayKit") }
        guard !includeMicrophone else { throw CapabilityError.invalidParameter("includeMicrophone") }
        let attempt = UUID()
        operation = attempt
        activeStartAttempt = attempt
        state = .starting
        recorder.isMicrophoneEnabled = false
        encoder.configure(framesPerSecond: min(2, max(0.5, framesPerSecond)))
        let frameHandler = onFrame
        let failureHandler = onFailure
        let encoder = self.encoder

        do {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                recorder.startCapture { sampleBuffer, sampleType, error in
                    if let error {
                        Task { @MainActor [weak self] in
                            guard let self, self.operation == attempt,
                                  self.state == .starting || self.state == .streaming else { return }
                            failureHandler?(error)
                        }
                        return
                    }
                    guard sampleType == .video, let dataURL = encoder.encode(sampleBuffer) else { return }
                    Task { @MainActor [weak self] in
                        guard let self, self.operation == attempt,
                              self.state == .starting || self.state == .streaming else { return }
                        frameHandler?(dataURL)
                    }
                } completionHandler: { error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume(returning: ()) }
                }
            }
        } catch {
            settleStart(attempt, didStart: false)
            if operation == attempt {
                startSettlements.removeValue(forKey: attempt)
                state = .stopped
            }
            throw error
        }

        settleStart(attempt, didStart: true)
        guard operation == attempt, state == .starting, !Task.isCancelled else {
            // A stop or task cancellation raced the asynchronous start. Wait for
            // the shared physical cleanup before exposing a stopped state.
            try? await stop()
            throw CapabilityError.cancelled("屏幕共享")
        }
        startSettlements.removeValue(forKey: attempt)
        state = .streaming
    }

    func stop() async throws {
        if let stopTask {
            try await stopTask.value
            return
        }
        guard state != .stopped else { return }
        let pendingStart = activeStartAttempt
        let attempt = UUID()
        operation = attempt
        stopGeneration = attempt
        state = .stopping
        let cleanup = Task { @MainActor in
            if let pendingStart {
                let didStart = await self.waitForStartSettlement(pendingStart)
                guard didStart else { return }
            }
            try await self.stopRecorder()
        }
        stopTask = cleanup
        do {
            try await cleanup.value
            if stopGeneration == attempt {
                stopTask = nil
                state = .stopped
            }
        } catch {
            if stopGeneration == attempt {
                stopTask = nil
                // A failed physical stop must not claim success or permit another
                // start while ReplayKit still reports an active recording.
                state = recorder.isRecording ? .streaming : .stopped
            }
            throw error
        }
    }

    func stop(ifCurrent expectedOperation: UUID) async throws {
        guard operation == expectedOperation else { return }
        try await stop()
    }

    private func settleStart(_ attempt: UUID, didStart: Bool) {
        if activeStartAttempt == attempt { activeStartAttempt = nil }
        let waiters = startSettlementWaiters.filter { $0.0 == attempt }
        startSettlementWaiters.removeAll { $0.0 == attempt }
        if waiters.isEmpty {
            startSettlements[attempt] = didStart
        } else {
            for (_, continuation) in waiters {
                continuation.resume(returning: didStart)
            }
        }
    }

    private func waitForStartSettlement(_ attempt: UUID) async -> Bool {
        if let settled = startSettlements.removeValue(forKey: attempt) {
            return settled
        }
        return await withCheckedContinuation { continuation in
            startSettlementWaiters.append((attempt, continuation))
        }
    }

    private func stopRecorder() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            recorder.stopCapture { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: ()) }
            }
        }
        recorder.isMicrophoneEnabled = false
    }
}

private final class ReplayFrameEncoder: @unchecked Sendable {
    private let lock = NSLock()
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var minimumInterval = 0.8
    private var lastFrameSeconds = -Double.infinity

    func configure(framesPerSecond: Double) {
        lock.lock()
        minimumInterval = 1 / framesPerSecond
        lastFrameSeconds = -Double.infinity
        lock.unlock()
    }

    func encode(_ sampleBuffer: CMSampleBuffer) -> String? {
        let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
        lock.lock()
        guard timestamp.isFinite, timestamp - lastFrameSeconds >= minimumInterval else {
            lock.unlock()
            return nil
        }
        lastFrameSeconds = timestamp
        lock.unlock()

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
        let source = CIImage(cvPixelBuffer: pixelBuffer)
        let maximumEdge: CGFloat = 540
        let scale = min(1, maximumEdge / max(source.extent.width, source.extent.height))
        let scaled = source.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent.integral) else { return nil }
        let image = UIImage(cgImage: cgImage)
        guard let data = image.jpegData(compressionQuality: 0.38),
              data.count <= DeviceProtocol.maximumJPEGBytes else { return nil }
        return DeviceProtocol.jpegDataURLPrefix + data.base64EncodedString()
    }
}
