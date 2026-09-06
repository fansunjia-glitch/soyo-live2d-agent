@preconcurrency import CoreLocation
import Foundation

@MainActor
final class LocationService {
    private var request: LocationRequest?

    func requestOneLocation() async throws -> CLLocation {
        guard request == nil else { throw CapabilityError.busy("位置请求") }
        let operation = LocationRequest()
        request = operation
        do {
            let location = try await operation.run()
            if request === operation { request = nil }
            return location
        } catch {
            if request === operation { request = nil }
            throw error
        }
    }

    func cancel() {
        let active = request
        request = nil
        active?.cancel()
    }
}

@MainActor
private final class LocationRequest: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocation, Error>?
    private var timeoutTask: Task<Void, Never>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    func run() async throws -> CLLocation {
        let authorization = manager.authorizationStatus
        guard authorization != .denied && authorization != .restricted else {
            throw CapabilityError.permissionDenied("位置")
        }

        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            if authorization == .notDetermined {
                manager.requestWhenInUseAuthorization()
            } else {
                manager.requestLocation()
            }
            timeoutTask = Task { [weak self] in
                do {
                    try await Task.sleep(for: .seconds(15))
                } catch {
                    return
                }
                self?.finish(.failure(CapabilityError.executionFailed("位置请求超时。")))
            }
        }
    }

    func cancel() {
        finish(.failure(CapabilityError.cancelled("位置请求")))
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard continuation != nil else { return }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            manager.requestLocation()
        case .denied, .restricted:
            finish(.failure(CapabilityError.permissionDenied("位置")))
        case .notDetermined:
            break
        @unknown default:
            finish(.failure(CapabilityError.permissionDenied("位置")))
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else {
            finish(.failure(CapabilityError.executionFailed("系统没有返回位置。")))
            return
        }
        finish(.success(location))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finish(.failure(error))
    }

    private func finish(_ result: Result<CLLocation, Error>) {
        let pending = continuation
        continuation = nil
        timeoutTask?.cancel()
        timeoutTask = nil
        manager.stopUpdatingLocation()
        pending?.resume(with: result)
    }
}
