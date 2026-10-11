import AVFoundation
import AudioToolbox

/// Single-owner, bounded PCM decoding. ExtAudioFileRead distinguishes clean EOF
/// from a real decoder failure; AVAudioFile's throwing bridge can report nilError
/// on a successful zero-frame MP3 read. Never suppress arbitrary decoder errors.
final class EncodedSpeechFile {
    private let file: ExtAudioFileRef
    let format: AVAudioFormat
    private let maximumFrames: Int64
    private var total: Int64 = 0
    private var ended = false

    init(url: URL, maximumSeconds: Double = 600) throws {
        var opened: ExtAudioFileRef?
        try Self.check(ExtAudioFileOpenURL(url as CFURL, &opened))
        guard let opened else { throw Failure.invalidFormat }
        do {
            var source = AudioStreamBasicDescription()
            var size = UInt32(MemoryLayout.size(ofValue: source))
            try Self.check(ExtAudioFileGetProperty(opened, kExtAudioFileProperty_FileDataFormat, &size, &source))
            guard source.mSampleRate.isFinite, (8_000...192_000).contains(source.mSampleRate),
                  (1...8).contains(source.mChannelsPerFrame), maximumSeconds.isFinite,
                  maximumSeconds > 0, maximumSeconds <= 600,
                  let format = AVAudioFormat(standardFormatWithSampleRate: source.mSampleRate, channels: source.mChannelsPerFrame) else { throw Failure.invalidFormat }
            var client = format.streamDescription.pointee
            try Self.check(ExtAudioFileSetProperty(opened, kExtAudioFileProperty_ClientDataFormat, UInt32(MemoryLayout.size(ofValue: client)), &client))
            self.file = opened; self.format = format
            maximumFrames = Int64(source.mSampleRate * maximumSeconds)
        } catch { ExtAudioFileDispose(opened); throw error }
    }
    deinit { ExtAudioFileDispose(file) }

    func read(frameCount: AVAudioFrameCount = 4096) throws -> AVAudioPCMBuffer? {
        if ended { return nil }
        guard frameCount > 0, frameCount <= 4096,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { throw Failure.invalidFormat }
        var frames = frameCount
        buffer.frameLength = frames
        try Self.check(ExtAudioFileRead(file, &frames, buffer.mutableAudioBufferList))
        buffer.frameLength = frames
        guard try EncodedSpeechRead.continueReading(frames, total: &total, maximum: maximumFrames) else {
            ended = true
            return nil
        }
        return buffer
    }
    private enum Failure: Error { case invalidFormat, decoder(OSStatus) }
    private static func check(_ status: OSStatus) throws {
        guard status == noErr else { throw Failure.decoder(status) }
    }
}
