@preconcurrency import AVFoundation
import Foundation

/// The synthesized buffer is copied before leaving Apple's callback. Consumers
/// receive owned, read-only PCM through one FIFO stream, including its end marker.
public struct SpeechPCMBuffer: @unchecked Sendable {
    public let buffer: AVAudioPCMBuffer
    fileprivate let id: UUID
}
public final class SpeechPCMStream: @unchecked Sendable {
    public let stream: AsyncThrowingStream<SpeechPCMBuffer, Error>
    private let continuation: AsyncThrowingStream<SpeechPCMBuffer, Error>.Continuation
    private let lock = NSLock()
    private var ended = false
    private var outstanding: [UUID: Int] = [:]
    private var queuedBytes = 0
    public let maximumBytes = 4 * 1024 * 1024
    public init() {
        let pair = AsyncThrowingStream<SpeechPCMBuffer, Error>.makeStream(bufferingPolicy: .bufferingOldest(4096))
        stream = pair.stream; continuation = pair.continuation
    }
    public func accept(_ buffer: AVAudioBuffer) {
        lock.lock(); defer { lock.unlock() }
        guard !ended else { return }
        guard let pcm = buffer as? AVAudioPCMBuffer else { fail("Speech synthesis returned an unsupported audio buffer."); return }
        if pcm.frameLength == 0 { ended = true; continuation.finish(); return }
        guard pcm.frameLength <= 65_536,
              let copy = AVAudioPCMBuffer(pcmFormat: pcm.format, frameCapacity: pcm.frameLength) else {
            fail("Speech synthesis exceeded its audio buffer limit."); return
        }
        let bytes = UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList).reduce(0) { $0 + Int($1.mDataByteSize) }
        guard bytes <= maximumBytes, queuedBytes + bytes <= maximumBytes else { fail("Speech playback could not keep up with synthesized audio."); return }
        copy.frameLength = pcm.frameLength
        let source = UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList)
        let destination = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for index in 0..<source.count {
            guard let from = source[index].mData, let to = destination[index].mData else { fail("Speech synthesis returned unreadable audio."); return }
            memcpy(to, from, Int(source[index].mDataByteSize))
        }
        let id = UUID(); outstanding[id] = bytes; queuedBytes += bytes
        switch continuation.yield(SpeechPCMBuffer(buffer: copy, id: id)) {
        case .enqueued: break
        case .terminated: ended = true
        case .dropped: fail("Speech playback could not keep up with synthesized audio.")
        @unknown default: fail("Speech playback lost its audio stream.")
        }
    }
    public func release(_ owned: SpeechPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        if let bytes = outstanding.removeValue(forKey: owned.id) { queuedBytes -= bytes }
    }
    private func fail(_ message: String) { ended = true; continuation.finish(throwing: VoiceFailure.unavailable(message)) }
}
