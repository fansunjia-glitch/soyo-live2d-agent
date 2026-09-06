import XCTest
@testable import SoyoCompanion

final class CommandSecurityTests: XCTestCase {
    private let now: Int64 = 2_000_000

    func testDecodesCurrentServerCommandShape() throws {
        let json = """
        {
          "type": "command",
          "schemaVersion": 1,
          "id": "command-1",
          "action": "device.open_url",
          "params": {"url": "https://example.com"},
          "requiresApproval": true,
          "issuedAt": 2000000,
          "expiresAt": 2030000,
          "nonce": "nonce-1"
        }
        """
        let message = try JSONDecoder().decode(IncomingMessage.self, from: Data(json.utf8))
        let command = try DeviceCommand(message: message)

        XCTAssertEqual(command.schemaVersion, 1)
        XCTAssertEqual(command.action, .openURL)
        XCTAssertEqual(command.params["url"], .string("https://example.com"))
        XCTAssertEqual(command.expiresAt, 2_030_000)
        XCTAssertEqual(command.nonce, "nonce-1")
    }

    func testValidCommandNormalizesNonceAndExpiry() throws {
        let command = makeCommand(id: "one", nonce: "nonce-one")
        let validated = try CommandValidator().validate(command, nowMilliseconds: now)

        XCTAssertEqual(validated.nonce, "nonce-one")
        XCTAssertEqual(validated.expiresAt, now + 30_000)
    }

    func testCurrentCommandRequiresVersionExpiryAndNonce() throws {
        let json = """
        {
          "type": "command",
          "id": "incomplete",
          "action": "device.info",
          "params": {},
          "requiresApproval": false,
          "issuedAt": 2000000
        }
        """
        let message = try JSONDecoder().decode(IncomingMessage.self, from: Data(json.utf8))
        XCTAssertThrowsError(try DeviceCommand(message: message))
    }

    func testExpiredAndFutureCommandsAreRejected() {
        let expired = makeCommand(id: "expired", issuedAt: now - 31_000)
        XCTAssertThrowsError(try CommandValidator().validate(expired, nowMilliseconds: now)) { error in
            XCTAssertEqual(error as? CommandSecurityError, .expired)
        }

        let future = makeCommand(id: "future", issuedAt: now + DeviceProtocol.maximumFutureClockSkew + 1)
        XCTAssertThrowsError(try CommandValidator().validate(future, nowMilliseconds: now)) { error in
            XCTAssertEqual(error as? CommandSecurityError, .issuedInFuture)
        }
    }

    func testUnsupportedVersionAndExcessiveTTLAreRejected() {
        let unsupported = makeCommand(id: "version", schemaVersion: 99)
        XCTAssertThrowsError(try CommandValidator().validate(unsupported, nowMilliseconds: now)) { error in
            XCTAssertEqual(error as? CommandSecurityError, .unsupportedProtocol(99))
        }

        let excessive = makeCommand(
            id: "ttl",
            lifetime: DeviceProtocol.maximumCommandTTL + 1
        )
        XCTAssertThrowsError(try CommandValidator().validate(excessive, nowMilliseconds: now)) { error in
            XCTAssertEqual(error as? CommandSecurityError, .invalidTTL)
        }
    }

    func testDuplicateCommandReturnsCachedResultWithoutReexecution() throws {
        let validated = try CommandValidator().validate(makeCommand(id: "same", nonce: "same-nonce"), nowMilliseconds: now)
        var ledger = CommandLedger()
        XCTAssertEqual(try ledger.begin(validated, nowMilliseconds: now), .execute)

        let outcome = CommandOutcome(ok: true, message: "done", data: nil)
        ledger.complete(commandId: "same", outcome: outcome)
        XCTAssertEqual(try ledger.begin(validated, nowMilliseconds: now), .duplicate(outcome))
    }

    func testNonceCannotBeReusedByAnotherCommand() throws {
        var ledger = CommandLedger()
        let first = try CommandValidator().validate(makeCommand(id: "first", nonce: "shared"), nowMilliseconds: now)
        let second = try CommandValidator().validate(makeCommand(id: "second", nonce: "shared"), nowMilliseconds: now)
        XCTAssertEqual(try ledger.begin(first, nowMilliseconds: now), .execute)

        XCTAssertThrowsError(try ledger.begin(second, nowMilliseconds: now)) { error in
            XCTAssertEqual(error as? CommandSecurityError, .nonceReplay)
        }
    }

    func testDecodesAndAuthenticatesCurrentDeviceSession() throws {
        let policyJSON = DeviceAction.approvalPolicy
            .sorted { $0.key < $1.key }
            .map { "\"\($0.key)\":\($0.value)" }
            .joined(separator: ",")
        let json = """
        {
          "type": "device_session",
          "schemaVersion": 1,
          "pairingId": "pairing-1",
          "deviceId": "device-1",
          "approvalPolicy": {\(policyJSON)},
          "controllerConnected": true
        }
        """
        let message = try JSONDecoder().decode(IncomingMessage.self, from: Data(json.utf8))
        let credentials = DeviceCredentials(
            serverURL: URL(string: "https://example.com")!,
            pairingId: "pairing-1",
            deviceId: "device-1",
            deviceToken: "secret",
            pairedAt: Date(timeIntervalSince1970: 0)
        )

        let session = try DeviceSession(message: message, credentials: credentials)
        XCTAssertEqual(session.approvalPolicy, DeviceAction.approvalPolicy)
        XCTAssertTrue(session.controllerConnected)
    }

    func testResultMessagesAlwaysCarryVersionCommandIdAndAction() throws {
        let command = makeCommand(id: "result-1")
        let outcome = CommandOutcome(ok: true, message: "done", data: nil)

        for message in [
            OutgoingMessage.commandResult(command: command, outcome: outcome),
            OutgoingMessage.approvalResult(command: command, allowed: true)
        ] {
            let data = try JSONEncoder().encode(message)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(object["schemaVersion"] as? Int, DeviceProtocol.currentVersion)
            XCTAssertEqual(object["id"] as? String, command.id)
            XCTAssertEqual(object["action"] as? String, command.actionName)
        }
    }

    func testScreenFrameMustBeJPEGDataURLWithinServerMessageLimit() throws {
        let frame = try OutgoingMessage.screenFrame(dataURL: DeviceProtocol.jpegDataURLPrefix + "AQID")
        let data = try JSONEncoder().encode(frame)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "screen_frame")
        XCTAssertEqual(object["dataUrl"] as? String, DeviceProtocol.jpegDataURLPrefix + "AQID")
        XCTAssertLessThanOrEqual(data.count, DeviceProtocol.maximumMessageBytes)

        XCTAssertThrowsError(try OutgoingMessage.screenFrame(dataURL: "data:image/png;base64,AQID"))
        XCTAssertThrowsError(
            try OutgoingMessage.screenFrame(
                dataURL: DeviceProtocol.jpegDataURLPrefix
                    + String(repeating: "A", count: DeviceProtocol.maximumMessageBytes)
            )
        )
    }

    private func makeCommand(
        id: String,
        schemaVersion: Int = DeviceProtocol.currentVersion,
        issuedAt: Int64? = nil,
        lifetime: Int64 = DeviceProtocol.maximumCommandTTL,
        nonce: String = "nonce"
    ) -> DeviceCommand {
        let commandIssuedAt = issuedAt ?? now
        return DeviceCommand(
            schemaVersion: schemaVersion,
            id: id,
            actionName: DeviceAction.info.rawValue,
            serverRequiresApproval: false,
            issuedAt: commandIssuedAt,
            expiresAt: commandIssuedAt + lifetime,
            nonce: nonce
        )
    }
}
