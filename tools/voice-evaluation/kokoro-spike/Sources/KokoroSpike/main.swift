import Foundation
import FluidAudio
import Darwin

struct Measurement: Codable {
    let passage: String
    let repeatNumber: Int
    let millisecondsToWholePCM: Double
    let engineStageMilliseconds: Double
    let usedFastVocoder: Bool
    let frames: Int
    let sampleRate: Int
    let peakRSSBytes: Int
}
@main struct KokoroSpike {
    static func clock() -> Double { ProcessInfo.processInfo.systemUptime }
    static func peakRSS() -> Int {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        return Int(usage.ru_maxrss)
    }
    static func main() async throws {
        let args = CommandLine.arguments
        guard args.count == 4, let limit = Int(args[3]), (1...10).contains(limit),
              ProcessInfo.processInfo.environment["OMNI_TTS_EVALUATION_CACHE"] != nil else {
            throw NSError(domain: "KokoroSpike requires corpus JSON, output directory, passage count and isolated cache", code: 1)
        }
        let corpus = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[1]))) as! [[String: String]]
        let output = URL(fileURLWithPath: args[2], isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        ModelHub.offlineMode = true
        let started = clock()
        let manager = KokoroAneManager(version: .v3)
        try await manager.initialize(preloadVoices: ["af_heart"])
        let initialization = (clock() - started) * 1000
        try String(initialization).write(to: output.appendingPathComponent("initialization-ms.txt"), atomically: true, encoding: .utf8)
        print("Initialization_ms=\(initialization); no playback; text normalization trait disabled")
        var rows: [Measurement] = []
        for item in corpus.prefix(limit) {
            guard let id = item["id"], let text = item["text"] else { continue }
            for repeatNumber in 1...3 {
                let before = clock()
                let result = try await manager.synthesizeDetailed(text: text, voice: "af_heart")
                let elapsed = (clock() - before) * 1000
                guard !result.samples.isEmpty, result.samples.allSatisfy(\.isFinite),
                      result.samples.contains(where: { abs($0) > 0.0001 }) else {
                    throw NSError(domain: "Empty, silent or invalid PCM", code: 2)
                }
                let wav = try pcmWAV(samples: result.samples, sampleRate: result.sampleRate)
                try wav.write(to: output.appendingPathComponent("\(id)-\(repeatNumber).wav"))
                rows.append(Measurement(passage: id, repeatNumber: repeatNumber, millisecondsToWholePCM: elapsed,
                                        engineStageMilliseconds: result.timings.totalMs, usedFastVocoder: result.usedFastVocoder,
                                        frames: result.samples.count, sampleRate: result.sampleRate, peakRSSBytes: peakRSS()))
                print("\(id)-\(repeatNumber): \(elapsed) ms to whole PCM; \(result.samples.count) frames")
                let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                try encoder.encode(rows).write(to: output.appendingPathComponent("measurements.json"))
            }
        }
    }
    static func pcmWAV(samples: [Float], sampleRate: Int) throws -> Data {
        guard samples.count < Int(UInt32.max / 2) else { throw NSError(domain: "PCM too large", code: 3) }
        var result = Data()
        func text(_ value: String) { result.append(contentsOf: value.utf8) }
        func uint32(_ value: UInt32) { var v = value.littleEndian; withUnsafeBytes(of: &v) { result.append(contentsOf: $0) } }
        func uint16(_ value: UInt16) { var v = value.littleEndian; withUnsafeBytes(of: &v) { result.append(contentsOf: $0) } }
        let bytes = UInt32(samples.count * 2)
        text("RIFF"); uint32(36 + bytes); text("WAVEfmt "); uint32(16)
        uint16(1); uint16(1); uint32(UInt32(sampleRate)); uint32(UInt32(sampleRate * 2)); uint16(2); uint16(16)
        text("data"); uint32(bytes)
        for sample in samples { uint16(UInt16(bitPattern: Int16(max(-1, min(1, sample)) * 32767))) }
        return result
    }
}
