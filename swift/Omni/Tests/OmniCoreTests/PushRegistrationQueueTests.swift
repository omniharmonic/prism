import XCTest
@testable import OmniCore

@MainActor
final class PushRegistrationQueueTests: XCTestCase {
    func testDelayedOldResponseCannotOverwriteExplicitSaveOrLaterCallback() async throws {
        let queue = PushRegistrationQueue()
        var preference = "generic"
        var serverPreference = "generic"
        var requests: [String] = []
        var response: CheckedContinuation<Void, Never>?
        let old = Task { @MainActor in
            try await queue.run {
                requests.append(preference)
                serverPreference = preference
                // Simulate the server applying a reconnect, then delaying its response.
                await withCheckedContinuation { response = $0 }
                return true
            }
        }
        while response == nil { await Task.yield() }
        let save = Task { @MainActor in
            try await queue.run {
                requests.append("title_preview")
                serverPreference = "title_preview"
                preference = "title_preview"
                return true
            }
        }
        await Task.yield()
        let callback = Task { @MainActor in
            try await queue.run {
                // Like APNs callbacks, read the preference at execution, not enqueue time.
                requests.append(preference)
                serverPreference = preference
                return true
            }
        }
        await Task.yield()
        XCTAssertEqual(requests, ["generic"], "no newer server write can overtake a delayed response")
        response?.resume()
        _ = try await old.value
        _ = try await save.value
        _ = try await callback.value
        XCTAssertEqual(requests, ["generic", "title_preview", "title_preview"])
        XCTAssertEqual(serverPreference, "title_preview")
    }

    func testDisableOrdersRemovalAndBlocksQueuedCallbacks() async throws {
        let queue = PushRegistrationQueue()
        var enabled = true
        var serverRegistered = true
        var oldResponse: CheckedContinuation<Void, Never>?
        let old = Task { @MainActor in
            try await queue.run {
                await withCheckedContinuation { oldResponse = $0 }
                serverRegistered = true
                return true
            }
        }
        while oldResponse == nil { await Task.yield() }
        let disable = Task { @MainActor in
            try await queue.run {
                serverRegistered = false
                enabled = false
                return true
            }
        }
        await Task.yield()
        let callback = Task { @MainActor in
            try await queue.run {
                guard enabled else { return false }
                serverRegistered = true
                return true
            }
        }
        await Task.yield()
        oldResponse?.resume()
        _ = try await old.value
        _ = try await disable.value
        let registered = try await callback.value
        XCTAssertFalse(registered)
        XCTAssertFalse(serverRegistered)
    }

    func testFailedSaveKeepsPreferenceAndReleasesQueue() async throws {
        enum Failure: Error { case offline }
        let queue = PushRegistrationQueue()
        var preference = "generic"
        do {
            _ = try await queue.run { throw Failure.offline }
            XCTFail("failed save succeeded")
        } catch {}
        _ = try await queue.run {
            XCTAssertEqual(preference, "generic")
            preference = "title"
            return true
        }
        XCTAssertEqual(preference, "title")
    }
}
