import CoreLocation
import Foundation
import UIKit

struct CapabilityDescriptor: Identifiable, Equatable, Sendable {
    let action: DeviceAction
    let title: String
    let explanation: String

    var id: String { action.rawValue }
    var requiresLocalApproval: Bool { action.requiresApprovalByProtocol }
}

struct CapabilityExecution: Sendable {
    let message: String
    let data: [String: JSONValue]?

    init(_ message: String, data: [String: JSONValue]? = nil) {
        self.message = message
        self.data = data
    }
}

@MainActor
final class CapabilityRegistry {
    let camera: CameraCaptureService
    let replayKit: ReplayKitStreamer

    private let location: LocationService
    private let speech: SpeechService

    static let descriptors: [CapabilityDescriptor] = [
        .init(action: .ping, title: "存活探测", explanation: "确认伴生端正在运行。"),
        .init(action: .info, title: "设备信息", explanation: "返回系统版本、App 版本和能力列表。"),
        .init(action: .openURL, title: "打开网页", explanation: "在系统中打开经过校验的 HTTP(S) 链接。"),
        .init(action: .copyText, title: "复制文本", explanation: "把远端提供的文本写入剪贴板。"),
        .init(action: .locationOnce, title: "一次位置", explanation: "仅在前台读取一次位置，不持续跟踪。"),
        .init(action: .speak, title: "本机朗读", explanation: "使用系统语音朗读远端提供的文字。"),
        .init(action: .cameraCapture, title: "拍摄照片", explanation: "展示系统相机，只有确认拍摄的照片才会返回。"),
        .init(action: .screenShareStart, title: "屏幕共享", explanation: "启动 ReplayKit 低帧率画面预览。"),
        .init(action: .screenShareStop, title: "停止共享", explanation: "停止当前 ReplayKit 捕获。"),
        .init(action: .shortcutOpen, title: "快捷指令", explanation: "打开指定快捷指令的系统深链。")
    ]

    init(
        camera: CameraCaptureService = CameraCaptureService(),
        replayKit: ReplayKitStreamer = ReplayKitStreamer(),
        location: LocationService = LocationService(),
        speech: SpeechService = SpeechService()
    ) {
        self.camera = camera
        self.replayKit = replayKit
        self.location = location
        self.speech = speech
    }

    var actions: [DeviceAction] { Self.descriptors.map(\.action) }

    func cancelPendingWork() {
        camera.cancel()
        location.cancel()
        speech.stop()
    }

    func descriptor(for action: DeviceAction) -> CapabilityDescriptor {
        Self.descriptors.first { $0.action == action }!
    }

    func approvalSummary(for command: DeviceCommand) -> String {
        guard let action = command.action else { return "请求执行未知动作。" }
        switch action {
        case .openURL:
            let raw = command.params.string("url") ?? ""
            guard let components = URLComponents(string: raw),
                  let host = components.host, !host.isEmpty,
                  components.user == nil, components.password == nil else {
                return "打开的链接格式无效，将被拒绝。"
            }
            return "打开站点：\(host)\n路径：\(short(components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath))"
        case .copyText:
            return "将 \(command.params.string("text")?.count ?? 0) 个字符写入剪贴板。"
        case .speak:
            return "朗读 \(command.params.string("text")?.count ?? 0) 个字符。"
        case .shortcutOpen:
            return "打开快捷指令：\(short(command.params.string("name") ?? "未提供"))"
        case .locationOnce:
            return "读取一次当前位置并返回给已配对控制端。"
        case .cameraCapture:
            return "打开相机；只有你确认拍摄的单张照片会被返回。"
        case .screenShareStart:
            let microphone = command.params.bool("includeMicrophone") ?? false
            return microphone
                ? "协议 v1 不支持麦克风音频，此请求将被拒绝。"
                : "启动 ReplayKit 低帧率画面共享，不包含麦克风。"
        default:
            return descriptor(for: action).explanation
        }
    }

    func execute(_ command: DeviceCommand) async throws -> CapabilityExecution {
        guard let action = command.action else { throw CapabilityError.unsupportedAction(command.actionName) }
        switch action {
        case .ping:
            return CapabilityExecution("pong")

        case .info:
            let descriptor = DeviceDescriptor.current(capabilities: actions)
            return CapabilityExecution("设备信息已刷新。", data: [
                "name": .string(descriptor.name),
                "model": .string(descriptor.model),
                "systemName": .string(descriptor.systemName),
                "systemVersion": .string(descriptor.systemVersion),
                "appVersion": .string(descriptor.appVersion),
                "capabilities": .array(descriptor.capabilities.map(JSONValue.string))
            ])

        case .openURL:
            let rawURL = try command.params.requiredString("url", maximumLength: 2_048)
            guard let components = URLComponents(string: rawURL),
                  let scheme = components.scheme?.lowercased(),
                  ["https", "http"].contains(scheme),
                  let host = components.host, !host.isEmpty,
                  components.user == nil, components.password == nil,
                  let url = components.url else {
                throw CapabilityError.invalidParameter("url")
            }
            let opened = await UIApplication.shared.open(url)
            guard opened else { throw CapabilityError.executionFailed("系统无法打开该链接。") }
            return CapabilityExecution("链接已交给系统打开。")

        case .copyText:
            let text = try command.params.requiredString("text", maximumLength: 4_000)
            UIPasteboard.general.string = text
            return CapabilityExecution("文本已复制到剪贴板。")

        case .locationOnce:
            let value = try await location.requestOneLocation()
            return CapabilityExecution("已读取一次位置。", data: [
                "latitude": .number(value.coordinate.latitude),
                "longitude": .number(value.coordinate.longitude),
                "horizontalAccuracy": .number(value.horizontalAccuracy),
                "timestamp": .number(value.timestamp.timeIntervalSince1970 * 1_000)
            ])

        case .speak:
            let text = try command.params.requiredString("text", maximumLength: 2_000)
            try speech.speak(text)
            return CapabilityExecution("已开始本机朗读。")

        case .cameraCapture:
            let dataURL = try await camera.captureJPEGDataURL()
            return CapabilityExecution("照片已拍摄。", data: ["imageDataUrl": .string(dataURL)])

        case .screenShareStart:
            if let microphone = command.params["includeMicrophone"], microphone.boolValue != false {
                throw CapabilityError.invalidParameter("includeMicrophone")
            }
            let fps = command.params.number("framesPerSecond") ?? 1.25
            try await replayKit.start(includeMicrophone: false, framesPerSecond: fps)
            return CapabilityExecution("ReplayKit 共享已开始。")

        case .screenShareStop:
            try await replayKit.stop()
            return CapabilityExecution("ReplayKit 共享已停止。")

        case .shortcutOpen:
            let name = try command.params.requiredString("name", maximumLength: 128)
            var components = URLComponents()
            components.scheme = "shortcuts"
            components.host = "run-shortcut"
            components.queryItems = [URLQueryItem(name: "name", value: name)]
            guard let url = components.url, await UIApplication.shared.open(url) else {
                throw CapabilityError.executionFailed("无法打开该快捷指令。")
            }
            return CapabilityExecution("快捷指令已交给系统打开。")
        }
    }

    private func short(_ value: String) -> String {
        value.count > 80 ? String(value.prefix(77)) + "…" : value
    }
}

enum CapabilityError: LocalizedError {
    case unsupportedAction(String)
    case invalidParameter(String)
    case parameterTooLarge(String)
    case unavailable(String)
    case permissionDenied(String)
    case busy(String)
    case cancelled(String)
    case executionFailed(String)

    var errorDescription: String? {
        switch self {
        case .unsupportedAction(let action): return "不支持能力：\(action)"
        case .invalidParameter(let name): return "参数 \(name) 无效。"
        case .parameterTooLarge(let name): return "参数 \(name) 过长。"
        case .unavailable(let name): return "当前设备无法使用\(name)。"
        case .permissionDenied(let name): return "没有\(name)权限。请在系统设置中检查。"
        case .busy(let name): return "\(name)正在处理其他请求。"
        case .cancelled(let name): return "用户取消了\(name)。"
        case .executionFailed(let reason): return reason
        }
    }
}

private extension Dictionary where Key == String, Value == JSONValue {
    func string(_ key: String) -> String? { self[key]?.stringValue }
    func bool(_ key: String) -> Bool? { self[key]?.boolValue }
    func number(_ key: String) -> Double? { self[key]?.numberValue }

    func requiredString(_ key: String, maximumLength: Int) throws -> String {
        guard let value = string(key)?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            throw CapabilityError.invalidParameter(key)
        }
        guard value.count <= maximumLength else { throw CapabilityError.parameterTooLarge(key) }
        return value
    }
}
