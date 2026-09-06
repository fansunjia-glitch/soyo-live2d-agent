import Foundation

struct PairingAPI {
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(session: URLSession = .shared) {
        self.session = session
    }

    func claim(serverURL rawServerURL: String, code rawCode: String, device: DeviceDescriptor) async throws -> DeviceCredentials {
        let serverURL = try ServerAddress.normalized(rawServerURL)
        let code = rawCode.filter(\.isNumber)
        guard code.count == 6 else { throw PairingError.invalidCode }

        let endpoint = serverURL.appending(path: "api/device-control/pairings/claim")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(PairingClaimRequest(code: code, device: device))

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw PairingError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let detail = (try? decoder.decode(ServerErrorResponse.self, from: data).detail)
            throw PairingError.server(status: http.statusCode, detail: detail)
        }
        let claim = try decoder.decode(PairingClaimResponse.self, from: data)
        guard !claim.pairingId.isEmpty, !claim.deviceId.isEmpty, !claim.deviceToken.isEmpty else {
            throw PairingError.invalidResponse
        }
        return DeviceCredentials(
            serverURL: serverURL,
            pairingId: claim.pairingId,
            deviceId: claim.deviceId,
            deviceToken: claim.deviceToken,
            pairedAt: Date()
        )
    }
}

enum ServerAddress {
    static func normalized(_ rawValue: String) throws -> URL {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              let host = components.host, !host.isEmpty else {
            throw PairingError.invalidServerURL
        }
        components.query = nil
        components.fragment = nil
        components.path = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if !components.path.isEmpty { components.path = "/\(components.path)" }

        if scheme != "https" {
            #if DEBUG
            guard scheme == "http", isPrivateDevelopmentHost(host) else {
                throw PairingError.insecureServerURL
            }
            #else
            throw PairingError.insecureServerURL
            #endif
        }
        guard let url = components.url else { throw PairingError.invalidServerURL }
        return url
    }

    static func webSocketURL(for credentials: DeviceCredentials) throws -> URL {
        guard var components = URLComponents(url: credentials.serverURL, resolvingAgainstBaseURL: false) else {
            throw PairingError.invalidServerURL
        }
        switch components.scheme?.lowercased() {
        case "https": components.scheme = "wss"
        case "http": components.scheme = "ws"
        default: throw PairingError.invalidServerURL
        }
        let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = "/" + ([basePath, "ws/device-control/device"].filter { !$0.isEmpty }.joined(separator: "/"))
        guard let url = components.url else { throw PairingError.invalidServerURL }
        return url
    }

    private static func isPrivateDevelopmentHost(_ host: String) -> Bool {
        let lowercased = host.lowercased()
        if lowercased == "localhost" || lowercased.hasSuffix(".local") || lowercased == "127.0.0.1" || lowercased == "::1" {
            return true
        }
        let octets = lowercased.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4 else { return false }
        return octets[0] == 10
            || (octets[0] == 172 && (16...31).contains(octets[1]))
            || (octets[0] == 192 && octets[1] == 168)
    }
}

private struct ServerErrorResponse: Decodable {
    let detail: String?
}

enum PairingError: LocalizedError {
    case invalidCode
    case invalidServerURL
    case insecureServerURL
    case invalidResponse
    case server(status: Int, detail: String?)

    var errorDescription: String? {
        switch self {
        case .invalidCode: return "配对码必须是 6 位数字。"
        case .invalidServerURL: return "请输入有效的服务端根地址。"
        case .insecureServerURL: return "生产环境只允许 HTTPS/WSS；Debug 仅额外允许私网地址。"
        case .invalidResponse: return "配对服务返回了无效响应。"
        case .server(let status, let detail): return detail ?? "配对失败（HTTP \(status)）。"
        }
    }
}
