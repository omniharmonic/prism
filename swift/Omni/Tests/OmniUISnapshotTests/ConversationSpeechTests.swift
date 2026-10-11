import XCTest
import AVFoundation
import OmniCore
import OmniClient
import OmniVoiceKit
@testable import OmniUI

@MainActor final class ConversationSpeechTests: XCTestCase {
    func testPlaybackFailureCategoriesNeverInspectPrivateErrorDetails() {
        XCTAssertEqual(SpeechPlaybackDiagnostic.event(for: SpeechPlaybackFailure.routeLost), .playbackRouteLost)
        XCTAssertEqual(SpeechPlaybackDiagnostic.event(for: SpeechPlaybackFailure.engineInactive), .playbackEngineInactive)
        XCTAssertEqual(SpeechPlaybackDiagnostic.event(for: SpeechPlaybackFailure.captureMissing), .playbackCaptureMissing)
        XCTAssertEqual(SpeechPlaybackDiagnostic.event(for: SpeechPlaybackFailure.bufferBudget), .playbackBufferBudget)
        XCTAssertEqual(SpeechPlaybackDiagnostic.event(for: NSError(domain: "private fixture", code: 99, userInfo: [NSLocalizedDescriptionKey: "private text"])), .playbackOtherFailure)
    }
    func testDecodedEOFDoesNotReachPlaybackQueue() throws {
        var total: Int64 = 0
        var queued: [UInt32] = []
        for frames: UInt32 in [4096, 128, 0, 4096] {
            guard try EncodedSpeechRead.read(total: &total, maximum: 4800, decode: { frames }) else { break }
            queued.append(frames)
        }
        XCTAssertEqual(queued, [4096, 128])
        XCTAssertEqual(total, 4224)
        enum Malformed: Error { case fixture }
        XCTAssertThrowsError(try EncodedSpeechRead.read(total: &total, maximum: 4800) { throw Malformed.fixture }) { XCTAssertTrue($0 is Malformed) }
        XCTAssertEqual(total, 4224)
        var empty: Int64 = 0
        XCTAssertThrowsError(try EncodedSpeechRead.continueReading(0, total: &empty, maximum: 4800))
        XCTAssertThrowsError(try EncodedSpeechRead.continueReading(4096, total: &total, maximum: 4800))
    }
    private func temporaryEncodedFixture() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("encoded-cleanup-\(UUID().uuidString).mp3")
        try Data([1, 2, 3]).write(to: url)
        return url
    }
    func testTemporaryEncodedFileRemovedAfterEOFAndMalformedDecode() async throws {
        let normal = try temporaryEncodedFixture()
        try await EncodedSpeechRead.withTemporaryFile(normal) {
            var total: Int64 = 0
            XCTAssertTrue(try EncodedSpeechRead.read(total: &total, maximum: 4096) { 128 })
            XCTAssertFalse(try EncodedSpeechRead.read(total: &total, maximum: 4096) { 0 })
            XCTAssertTrue(FileManager.default.fileExists(atPath: normal.path))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: normal.path))
        let malformed = try temporaryEncodedFixture()
        enum DecodeError: Error { case malformed }
        do {
            try await EncodedSpeechRead.withTemporaryFile(malformed) {
                var total: Int64 = 0
                _ = try EncodedSpeechRead.read(total: &total, maximum: 4096) { throw DecodeError.malformed }
            }
            XCTFail("Malformed decode must fail")
        } catch { XCTAssertTrue(error is DecodeError) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: malformed.path))
    }
    func testTemporaryEncodedFileRemovedWhenCancelledBeforeRead() async throws {
        let url = try temporaryEncodedFixture()
        var reads = 0
        let task = Task { @MainActor in
            try await EncodedSpeechRead.withTemporaryFile(url) {
                try Task.checkCancellation()
                reads += 1
            }
        }
        task.cancel()
        do { try await task.value; XCTFail("Expected cancellation") } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(reads, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
    func testTemporaryEncodedFileRemovedWhenCancelledDuringHardwareBackpressure() async throws {
        let url = try temporaryEncodedFixture()
        let queue = SpeechPlaybackQueue(maximumSeconds: 1)
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16000))
        buffer.frameLength = 16000
        try await queue.schedule(buffer) { _, _ in } // hardware has not drained
        let waiting = expectation(description: "decoder reaches backpressure")
        let task = Task { @MainActor in
            try await EncodedSpeechRead.withTemporaryFile(url) {
                waiting.fulfill()
                try await queue.schedule(buffer) { _, _ in XCTFail("Full hardware queue must not schedule") }
            }
        }
        await fulfillment(of: [waiting], timeout: 1)
        task.cancel()
        do { try await task.value; XCTFail("Expected cancellation") } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        queue.cancel()
    }
    final class Output: ConversationSpeechOutput {
        var texts: [String] = []
        var identifiers: [String?] = []
        var rates: [Float] = []
        var completions: [@MainActor () -> Void] = []
        var audio: [Data] = []
        var failAudio = false
        func playAudio(_ data: Data, completion: @escaping @MainActor () -> Void) throws {
            if failAudio { throw NSError(domain: "fixture", code: 1) }
            audio.append(data); completions.append(completion)
        }
        var stops = 0
        var failure: (@MainActor (String) -> Void)?
        func configureFailure(_ receive: @escaping @MainActor (String) -> Void) { failure = receive }
        func speak(_ text: String, identifier: String?, rate: Float, completion: @escaping @MainActor () -> Void) {
            texts.append(text); identifiers.append(identifier); rates.append(rate); completions.append(completion)
        }
        func stop() { stops += 1 }
    }
    func testRecordingStopsPreviewAndRejectsPlaybackUntilOwnerReleases() {
        let output = Output(); let speech = ConversationSpeech(output: output, diagnostic: { _ in }); let playbackOwner = UUID()
        speech.preview(owner: playbackOwner, identifier: "chosen", rate: 0.6)
        speech.stopPreview(owner: UUID()); speech.silence(owner: UUID())
        XCTAssertTrue(speech.isPreviewing)
        XCTAssertEqual(output.identifiers, ["chosen"]); XCTAssertEqual(output.rates, [0.6])
        let owner = UUID(); speech.beginRecording(owner: owner)
        speech.silence(owner: UUID())
        XCTAssertFalse(speech.isPreviewing)
        speech.preview(owner: playbackOwner, identifier: nil, rate: 0.5); speech.speak("No capture overlap.", owner: playbackOwner, identifier: nil, rate: 0.5)
        XCTAssertEqual(output.texts.count, 1)
        speech.endRecording(owner: UUID()) // stale device cannot release another microphone owner
        speech.preview(owner: playbackOwner, identifier: nil, rate: 0.5)
        XCTAssertEqual(output.texts.count, 1)
        speech.endRecording(owner: owner)
        speech.preview(owner: playbackOwner, identifier: nil, rate: 0.5)
        output.completions[0]() // late cancelled preview cannot clear the new preview
        XCTAssertTrue(speech.isPreviewing)
        output.completions[1]()
        XCTAssertFalse(speech.isPreviewing)
    }
    func testReplyPreemptsPreviewAndPreviewNeverPreemptsQueuedReplies() {
        let output = Output(); let speech = ConversationSpeech(output: output, diagnostic: { _ in }); let playbackOwner = UUID()
        speech.preview(owner: playbackOwner, identifier: nil, rate: 0.5)
        speech.speak("First sentence.", owner: playbackOwner, identifier: nil, rate: 0.5)
        speech.speak("Second sentence.", owner: playbackOwner, identifier: nil, rate: 0.5)
        XCTAssertFalse(speech.isPreviewing)
        let stops = output.stops
        speech.silence(owner: UUID())
        XCTAssertEqual(output.stops, stops)
        speech.preview(owner: playbackOwner, identifier: nil, rate: 0.5)
        speech.stopPreview(owner: playbackOwner) // dismissal must not silence a reply that replaced the preview
        XCTAssertEqual(output.texts.count, 3)
        output.completions[0](); output.completions[1]()
        speech.preview(owner: playbackOwner, identifier: nil, rate: 0.5)
        XCTAssertEqual(output.texts.count, 3)
        output.completions[2]()
        speech.preview(owner: playbackOwner, identifier: nil, rate: 0.5)
        XCTAssertEqual(output.texts.count, 4)
        speech.stopPreview(owner: playbackOwner); XCTAssertFalse(speech.isPreviewing)
    }
    func testPlaybackDrainWaitsForEveryQueuedSentence() async {
        let output = Output(); let speech = ConversationSpeech(output: output, diagnostic: { _ in }); let owner = UUID()
        speech.speak("First.", owner: owner, identifier: nil, rate: 0.5)
        speech.speak("Second.", owner: owner, identifier: nil, rate: 0.5)
        var drained = false
        let waiter = Task { await speech.waitForPlayback(owner: owner); drained = true }
        await Task.yield()
        output.completions[0]()
        await Task.yield()
        XCTAssertFalse(drained)
        output.completions[1]()
        await waiter.value
        XCTAssertTrue(drained)
    }
    func testSilenceReleasesDrainAndLateCallbackCannotFinishNewPlayback() async {
        let output = Output(); let speech = ConversationSpeech(output: output, diagnostic: { _ in }); let owner = UUID()
        speech.speak("Cancelled.", owner: owner, identifier: nil, rate: 0.5)
        let waiter = Task { await speech.waitForPlayback(owner: owner) }
        await Task.yield()
        speech.silence(owner: owner)
        await waiter.value
        speech.speak("Current.", owner: owner, identifier: nil, rate: 0.5)
        var drained = false
        let current = Task { await speech.waitForPlayback(owner: owner); drained = true }
        await Task.yield()
        output.completions[0]()
        await Task.yield()
        XCTAssertFalse(drained)
        output.completions[1]()
        await current.value
        XCTAssertTrue(drained)
    }
    func testPlaybackFailureReportsBeforeDrainAndIgnoresStaleOwner() async {
        let output = Output(); let speech = ConversationSpeech(output: output, diagnostic: { _ in }); let owner = UUID()
        var failure = ""
        speech.configurePlaybackFailure(owner: owner) { failure = $0 }
        let oldFailure = output.failure
        speech.speak("Reply.", owner: owner, identifier: nil, rate: 0.5)
        var drained = false
        let waiter = Task { await speech.waitForPlayback(owner: owner); drained = true }
        await Task.yield()
        output.failure?("Output route failed")
        await waiter.value
        XCTAssertEqual(failure, "Output route failed")
        XCTAssertTrue(drained)
        failure = ""
        speech.speak("Different session.", owner: UUID(), identifier: nil, rate: 0.5)
        oldFailure?("Stale error")
        XCTAssertTrue(failure.isEmpty)
    }

    func testGeneratedAudioUsesSameOwnedDrainAndCancelledCompletionCannotReleaseNewReply() async throws {
        let output = Output(); let speech = ConversationSpeech(output: output, diagnostic: { _ in }); let owner = UUID()
        try speech.playAudio(Data([1]), owner: owner)
        var drained = false
        let waiting = Task { await speech.waitForPlayback(owner: owner); drained = true }
        await Task.yield(); XCTAssertFalse(drained)
        speech.silence(owner: owner); await waiting.value
        XCTAssertTrue(drained)
        try speech.playAudio(Data([2]), owner: owner)
        var nextDrained = false
        let next = Task { await speech.waitForPlayback(owner: owner); nextDrained = true }
        await Task.yield()
        output.completions[0](); await Task.yield()
        XCTAssertFalse(nextDrained)
        output.completions[1](); await next.value
        XCTAssertTrue(nextDrained); XCTAssertEqual(output.audio, [Data([1]), Data([2])])
    }
    func testGeneratedAudioSetupFailureDoesNotStrandDrain() async {
        let output = Output(); output.failAudio = true
        let speech = ConversationSpeech(output: output, diagnostic: { _ in }); let owner = UUID()
        XCTAssertThrowsError(try speech.playAudio(Data([1]), owner: owner))
        await speech.waitForPlayback(owner: owner)
        XCTAssertTrue(output.audio.isEmpty)
    }

    func testRemotePreviewReservationBlocksCaptureReplyPreparationAndPendingAudio() throws {
        let output = Output(); let speech = ConversationSpeech(output: output, diagnostic: { _ in }); let owner = UUID()
        speech.beginRecording(owner: owner)
        XCTAssertNil(speech.reservePreview(owner: UUID(), cancel: {}))
        speech.endRecording(owner: owner)
        let preparation = try XCTUnwrap(speech.reserveReplyPreparation(owner: owner))
        XCTAssertNil(speech.reservePreview(owner: owner, cancel: {}))
        speech.releaseReplyPreparation(preparation)
        try speech.playAudio(Data([1]), owner: owner)
        XCTAssertNil(speech.reservePreview(owner: owner, cancel: {}))
        XCTAssertThrowsError(try speech.playAudio(Data([2]), owner: owner))
        XCTAssertEqual(output.audio, [Data([1])])
        output.completions[0]()
        XCTAssertNotNil(speech.reservePreview(owner: UUID(), cancel: {}))
    }
    func testPreviewLeaseCancelledByCaptureRejectsLateGeneratedAudio() throws {
        let output = Output(); let speech = ConversationSpeech(output: output, diagnostic: { _ in }); let previewOwner = UUID()
        var cancelled = false
        let lease = try XCTUnwrap(speech.reservePreview(owner: previewOwner, cancel: { cancelled = true }))
        speech.beginRecording(owner: UUID())
        XCTAssertTrue(cancelled)
        XCTAssertThrowsError(try speech.playPreviewAudio(Data([1]), owner: previewOwner, lease: lease))
        XCTAssertTrue(output.audio.isEmpty)
    }
    func testEncodedPreviewUsesLeaseAndDrains() async throws {
        let output = Output(); let speech = ConversationSpeech(output: output, diagnostic: { _ in }); let owner = UUID()
        let lease = try XCTUnwrap(speech.reservePreview(owner: owner, cancel: {}))
        try speech.playPreviewAudio(Data([1]), owner: owner, lease: lease)
        var drained = false
        let task = Task { await speech.waitForPlayback(owner: owner); drained = true }
        await Task.yield(); XCTAssertFalse(drained)
        output.completions[0](); await task.value
        XCTAssertFalse(speech.isPreviewing); XCTAssertFalse(speech.ownsPreview(lease, owner: owner))
    }

    actor CatalogService: HermesSpeechService {
        var synthesisCount = 0
        var gate: CheckedContinuation<VoiceProviderCatalog, Never>?
        func voiceProviders() async throws -> VoiceProviderCatalog {
            await withCheckedContinuation { gate = $0 }
        }
        func waiting() -> Bool { gate != nil }
        func finish(available: Bool = true) throws {
            let source = Data("{\"providers\":[{\"id\":\"hermes-edge\",\"name\":\"Edge\",\"available\":true,\"cloud\":true,\"disclosure\":\"Microsoft\",\"defaultVoiceID\":\"aria\",\"voices\":[],\"maxCharacters\":4000,\"maxAudioBytes\":10485760}]}".utf8)
            let catalog = try JSONDecoder().decode(VoiceProviderCatalog.self, from: source)
            let updated = try JSONDecoder().decode(VoiceProviderCatalog.self, from: Data(String(decoding: source, as: UTF8.self).replacingOccurrences(of: "\"available\":true", with: "\"available\":false").utf8))
            gate?.resume(returning: available ? catalog : updated); gate = nil
        }
        func synthesizeVoice(_ request: VoiceSynthesisRequest) async throws -> Data { synthesisCount += 1; return Data([1]) }
        func cancelVoiceSynthesis(sessionID: String, requestID: String) async throws {}
    }
    func testProviderCatalogCannotRepopulateAfterCancellationOrServiceReplacement() async throws {
        let device = ConversationDevice(diagnostic: { _ in }); let service = CatalogService()
        device.configureReplySpeech(service: service)
        let task = Task { await device.refreshReplyProviders() }
        while !(await service.waiting()) { await Task.yield() }
        device.configureReplySpeech(service: service) // repeated SwiftUI adoption keeps in-flight metadata valid
        try await service.finish(); await task.value
        XCTAssertEqual(device.replyProviders.first?.available, true)
        device.configureReplySpeech(service: nil)
        device.configureReplySpeech(service: service)
        let cancelled = Task { await device.refreshReplyProviders() }
        while !(await service.waiting()) { await Task.yield() }
        device.cancel(); try await service.finish(); await cancelled.value
        XCTAssertTrue(device.replyProviders.isEmpty)
        let replacement = CatalogService()
        device.configureReplySpeech(service: replacement)
        let stale = Task { await device.refreshReplyProviders() }
        while !(await replacement.waiting()) { await Task.yield() }
        device.configureReplySpeech(service: nil)
        try await replacement.finish(); await stale.value
        XCTAssertTrue(device.replyProviders.isEmpty)
    }

    func testNextReplySessionRefreshesUnavailableCatalogAndRejectsPriorSessionResult() async throws {
        let device = ConversationDevice(diagnostic: { _ in }); let service = CatalogService()
        device.configureReplySpeech(service: service)
        let initial = Task { await device.refreshReplyProviders() }
        while !(await service.waiting()) { await Task.yield() }
        try await service.finish(available: false); await initial.value
        XCTAssertEqual(device.replyProviders.first?.available, false)
        let stale = Task { await device.refreshReplyProviders() }
        while !(await service.waiting()) { await Task.yield() }
        device.beginReplySpeechSession()
        try await service.finish(); await stale.value
        XCTAssertEqual(device.replyProviders.first?.available, false)
        let fresh = Task { await device.refreshReplyProviders() }
        while !(await service.waiting()) { await Task.yield() }
        try await service.finish(); await fresh.value
        XCTAssertEqual(device.replyProviders.first?.id, "hermes-edge")
    }

    func testDeviceSilenceCancelsLongReplyAndQueuedReplyWithoutStartingAnotherCloudPassage() async throws {
        let output = Output(); let speech = ConversationSpeech(output: output, diagnostic: { _ in })
        let name = "NarrationCancellation." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let preferences = ReplySpeechPreferences(defaults: defaults)
        let device = ConversationDevice(speech: speech, replyPreferences: preferences, diagnostic: { _ in })
        let service = CatalogService(); device.configureReplySpeech(service: service)
        device.speak(String(repeating: "passage ", count: 1000))
        device.speak("Queued second reply.")
        while !(await service.waiting()) { await Task.yield() }
        try await service.finish()
        while output.audio.isEmpty { await Task.yield() }
        let firstCount = await service.synthesisCount
        XCTAssertEqual(firstCount, 1)
        device.silence()
        output.completions[0]() // hardware callback from the cancelled passage
        await device.waitForPlayback()
        for _ in 0..<10 { await Task.yield() }
        let count = await service.synthesisCount
        XCTAssertEqual(count, 1); XCTAssertEqual(output.audio.count, 1)
    }

    func testEncodedPreviewFailureClearsLeaseAndReleasesDrain() async throws {
        let output = Output(); let speech = ConversationSpeech(output: output, diagnostic: { _ in }); let owner = UUID()
        var failure = ""
        let lease = try XCTUnwrap(speech.reservePreview(owner: owner, cancel: {}))
        speech.configurePlaybackFailure(owner: owner) { failure = $0 }
        try speech.playPreviewAudio(Data([1]), owner: owner, lease: lease)
        let drain = Task { await speech.waitForPlayback(owner: owner) }
        await Task.yield()
        output.failure?("Preview route failed")
        await drain.value
        XCTAssertEqual(failure, "Preview route failed")
        XCTAssertFalse(speech.isPreviewing); XCTAssertFalse(speech.ownsPreview(lease, owner: owner))
    }

    func testFailureCleanupCannotStopReplacementReplyStartedByCallback() async throws {
        let output = Output(); let speech = ConversationSpeech(output: output, diagnostic: { _ in }); let owner = UUID()
        speech.configurePlaybackFailure(owner: owner) { _ in
            speech.speak("Replacement reply.", owner: owner, identifier: nil, rate: 0.5)
        }
        try speech.playAudio(Data([1]), owner: owner)
        output.failure?("The previous generated reply failed")
        XCTAssertEqual(output.texts, ["Replacement reply."])
        var drained = false
        let waiter = Task { await speech.waitForPlayback(owner: owner); drained = true }
        await Task.yield()
        XCTAssertFalse(drained, "Old failure cleanup must not release the replacement reply")
        output.completions[0]() // late callback from the failed MP3
        await Task.yield(); XCTAssertFalse(drained)
        output.completions[1](); await waiter.value
        XCTAssertTrue(drained)
    }

    func testEncodedPlaybackDiagnosticBoundariesContainOnlyAllowedMetadata() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appending(path: "events.json")
        let log = VoiceEventLog(url: url)
        let output = Output(); let speech = ConversationSpeech(output: output, diagnostic: log.record)
        let owner = UUID()
        try speech.playAudio(Data([1]), owner: owner)
        output.completions[0]()
        output.failAudio = true
        XCTAssertThrowsError(try speech.playAudio(Data([2]), owner: owner))
        await log.flush()
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
        XCTAssertEqual(rows.compactMap { $0["event"] as? String }, ["playbackStarted", "playbackFinished", "playbackFailed"])
        XCTAssertTrue(rows.allSatisfy { Set($0.keys) == ["at", "event"] })
    }

}
