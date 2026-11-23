import Foundation
import FluidAudio

/// Persistent, isolated Mac worker. The host owns authentication, request
/// deadlines, cancellation (terminate worker), restart and provider fallback.
@main struct KokoroWorker {
    struct Request: Decodable { let id: String; let text: String }
    struct Response: Encodable {
        let id: String
        let status: String
        var ready: Bool? = nil
        var wavBase64: String? = nil
        var sampleRate: Int? = nil
        var frames: Int? = nil
        var error: String? = nil
    }
    static let maxLineBytes = 8192
    static let maxCharacters = 160
    static let maxSeconds = 30

    static func send(_ response: Response) throws {
        var data = try JSONEncoder().encode(response)
        data.append(10)
        try FileHandle.standardOutput.write(contentsOf: data)
    }

    // Read a bounded protocol line. Abort oversized input rather than retaining
    // unbounded stdin or trying to continue with a partially consumed request.
    static func readLine() throws -> Data? {
        var line = Data()
        while let byte = try FileHandle.standardInput.read(upToCount: 1), !byte.isEmpty {
            if byte[0] == 10 { return line }
            guard line.count < maxLineBytes else { throw WorkerError.invalidRequest }
            line.append(byte)
        }
        return line.isEmpty ? nil : line
    }
    enum WorkerError: Error { case invalidRequest, invalidAudio, missingCache }

    static func main() async throws {
        guard let configured = ProcessInfo.processInfo.environment["OMNI_TTS_EVALUATION_CACHE"],
              configured.hasPrefix("/"), FileManager.default.fileExists(atPath: configured) else {
            throw WorkerError.missingCache
        }
        AppLogger.minimumLevel = .fault
        AppLogger.mirrorsToConsole = false
        // This process has no ASR client and never changes the app's policy.
        ModelHub.offlineMode = true
        let manager = KokoroAneManager(version: .v3)
        try await manager.initialize(preloadVoices: ["af_heart"])
        try send(Response(id: "", status: "ready", ready: true))
        while let line = try readLine() {
            guard let request = try? JSONDecoder().decode(Request.self, from: line),
                  !request.id.isEmpty, request.id.utf8.count <= 128,
                  !request.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  request.text.utf16.count <= maxCharacters else {
                try send(Response(id: "", status: "error", error: "invalid_request"))
                continue
            }
            do {
                let result = try await manager.synthesizeDetailed(text: request.text, voice: "af_heart")
                let wave = try wav(samples: result.samples, sampleRate: result.sampleRate)
                try send(Response(id: request.id, status: "ok", wavBase64: wave.base64EncodedString(),
                                  sampleRate: result.sampleRate, frames: result.samples.count))
            } catch {
                // No private text, file paths, underlying errors or commands on
                // the protocol channel. Host observes process exits separately.
                try send(Response(id: request.id, status: "error", error: "synthesis_failed"))
            }
        }
        await manager.cleanup()
    }

    static func wav(samples: [Float], sampleRate: Int) throws -> Data {
        guard sampleRate == 24_000, !samples.isEmpty,
              samples.count <= sampleRate * maxSeconds,
              samples.allSatisfy(\.isFinite), samples.contains(where: { abs($0) > 0.0001 }) else {
            throw WorkerError.invalidAudio
        }
        var data = Data(capacity: 44 + samples.count * 2)
        func ascii(_ value: String) { data.append(contentsOf: value.utf8) }
        func u16(_ value: UInt16) {
            var bytes = value.littleEndian
            withUnsafeBytes(of: &bytes) { data.append(contentsOf: $0) }
        }
        func u32(_ value: UInt32) {
            var bytes = value.littleEndian
            withUnsafeBytes(of: &bytes) { data.append(contentsOf: $0) }
        }
        let byteCount = UInt32(samples.count * 2)
        ascii("RIFF"); u32(36 + byteCount); ascii("WAVEfmt "); u32(16)
        u16(1); u16(1); u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 2)); u16(2); u16(16)
        ascii("data"); u32(byteCount)
        for sample in samples { u16(UInt16(bitPattern: Int16(max(-1, min(1, sample)) * 32767))) }
        return data
    }
}
