import Foundation

/// Reads the entitlement from the signed executable, including distribution builds with
/// no embedded provisioning profile. An absent/malformed entitlement disables registration.
/// Only thin 64-bit Mach-O images are needed on iPhone/iPad; bounds are checked before reads.
public enum PushEnvironment {
    public static func signed(bundle: Bundle = .main) -> String? {
        guard let url = bundle.executableURL, let bytes = try? Data(contentsOf: url, options: .mappedIfSafe) else { return nil }
        return entitlement(in: bytes)
    }

    public static func entitlement(in bytes: Data) -> String? {
        func word(_ offset: Int, big: Bool = false) -> UInt32? {
            guard offset >= 0, offset <= bytes.count - 4 else { return nil }
            let a = Array(bytes[offset..<offset + 4])
            return big ? a.reduce(0) { ($0 << 8) | UInt32($1) } : a.reversed().reduce(0) { ($0 << 8) | UInt32($1) }
        }
        // Universal Mac executables contain separately signed thin slices.
        if word(0, big: true) == 0xcafebabe {
            guard let slices = word(4, big: true), slices <= 64, 8 + Int(slices) * 20 <= bytes.count else { return nil }
            for index in 0..<Int(slices) {
                let entry = 8 + index * 20
                guard let offset = word(entry + 8, big: true), let length = word(entry + 12, big: true),
                      Int(offset) <= bytes.count, Int(length) <= bytes.count - Int(offset),
                      length >= 32, word(Int(offset)) == 0xfeedfacf else { continue }
                if let value = entitlement(in: Data(bytes[Int(offset)..<(Int(offset) + Int(length))])) { return value }
            }
            return nil
        }
        guard word(0) == 0xfeedfacf, let count = word(16), count <= 4096 else { return nil }
        var cursor = 32
        for _ in 0..<count {
            guard let command = word(cursor), let size = word(cursor + 4), size >= 8,
                  Int(size) <= bytes.count - cursor else { return nil }
            defer { cursor += Int(size) }
            guard command == 0x1d else { continue } // LC_CODE_SIGNATURE
            guard size >= 16, let start = word(cursor + 8), let length = word(cursor + 12),
                  Int(start) <= bytes.count, Int(length) <= bytes.count - Int(start) else { return nil }
            let base = Int(start), end = base + Int(length)
            guard word(base, big: true) == 0xfade0cc0, let total = word(base + 4, big: true),
                  total <= length, let slots = word(base + 8, big: true), slots <= 4096,
                  12 + Int(slots) * 8 <= Int(total) else { return nil }
            for index in 0..<Int(slots) {
                let item = base + 12 + index * 8
                guard word(item, big: true) == 5, let relative = word(item + 4, big: true) else { continue }
                let blob = base + Int(relative)
                guard blob >= base, blob <= end - 8, word(blob, big: true) == 0xfade7171,
                      let blobLength = word(blob + 4, big: true), blobLength >= 8,
                      Int(blobLength) <= end - blob else { return nil }
                let plist = bytes[(blob + 8)..<(blob + Int(blobLength))]
                guard let values = try? PropertyListSerialization.propertyList(from: Data(plist), format: nil) as? [String: Any] else { return nil }
                let value = values["aps-environment"] as? String ?? values["com.apple.developer.aps-environment"] as? String
                switch value {
                case "development": return "sandbox"
                case "production": return "production"
                default: return nil
                }
            }
        }
        return nil
    }
}
