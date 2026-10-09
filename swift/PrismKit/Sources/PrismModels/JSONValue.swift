import CryptoKit
import Foundation

/// Any JSON value. Used where the server's shape is open (approval payloads, tool
/// inputs, executor results) and for the approval digest.
public enum JSONValue: Sendable, Hashable {
    case null
    case bool(Bool)
    /// An integer that fits `Int64`.
    case int(Int64)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public var stringValue: String? { if case .string(let s) = self { return s } else { return nil } }
    public var boolValue: Bool? { if case .bool(let b) = self { return b } else { return nil } }
    public var intValue: Int? {
        switch self {
        case .int(let i): return Int(exactly: i)
        case .double(let d): return Int(exactly: d)
        default: return nil
        }
    }
    public var doubleValue: Double? {
        switch self {
        case .int(let i): return Double(i)
        case .double(let d): return d
        default: return nil
        }
    }
    public var arrayValue: [JSONValue]? { if case .array(let a) = self { return a } else { return nil } }
    public var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o } else { return nil } }
    /// An array whose elements are all strings (`to`, `cc`, `attendees`, …).
    public var stringArrayValue: [String]? {
        guard let a = arrayValue else { return nil }
        let s = a.compactMap(\.stringValue)
        return s.count == a.count ? s : nil
    }
    public var isNull: Bool { self == .null }

    public subscript(key: String) -> JSONValue? { objectValue?[key] }
    public subscript(index: Int) -> JSONValue? {
        guard let a = arrayValue, a.indices.contains(index) else { return nil }
        return a[index]
    }
}

extension JSONValue: Codable {
    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let i = try? c.decode(Int64.self) {
            self = .int(i)
        } else if let d = try? c.decode(Double.self) {
            self = .double(d)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else {
            self = .object(try c.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .int(let i): try c.encode(i)
        case .double(let d): try c.encode(d)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int64) { self = .int(value) }
    public init(floatLiteral value: Double) { self = .double(value) }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) { self = .object(Dictionary(elements, uniquingKeysWith: { _, b in b })) }
    public init(nilLiteral: ()) { self = .null }
}

// MARK: - Canonical JSON (byte-identical to the server)

extension JSONValue {
    /// The server's `canonicalJson` (`apps/server/src/omni/approvals.ts`): object keys
    /// sorted at every depth by UTF-16 code unit (JavaScript's default `.sort()`), no
    /// whitespace, and every scalar exactly as JavaScript's `JSON.stringify` prints it.
    ///
    /// Proven against vectors produced by the server function itself
    /// (`Tests/PrismModelsTests/Fixtures/approval-digest-vectors.json`).
    ///
    /// Known limits (not reachable through a validated approval payload, whose keys are
    /// fixed ASCII names and whose values are strings or lists of strings): two keys that
    /// are canonically equivalent Unicode but different code points collapse in a Swift
    /// dictionary, and integers beyond ±2^53 are printed as JavaScript would after its own
    /// loss of precision.
    public var canonicalJSON: String {
        var out = ""
        writeCanonical(into: &out)
        return out
    }

    private func writeCanonical(into out: inout String) {
        switch self {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .int(let i):
            if i.magnitude <= 9_007_199_254_740_992 { out += String(i) } else { out += Self.javaScriptNumber(Double(i)) }
        case .double(let d): out += Self.javaScriptNumber(d)
        case .string(let s): Self.writeString(s, into: &out)
        case .array(let a):
            out += "["
            for (i, v) in a.enumerated() {
                if i > 0 { out += "," }
                v.writeCanonical(into: &out)
            }
            out += "]"
        case .object(let o):
            out += "{"
            let keys = o.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
            for (i, k) in keys.enumerated() {
                if i > 0 { out += "," }
                Self.writeString(k, into: &out)
                out += ":"
                o[k]!.writeCanonical(into: &out)
            }
            out += "}"
        }
    }

    /// `JSON.stringify` string quoting: `"` `\` and the short escapes, `\u00xx` (lower-case
    /// hex) for other C0 controls, everything else — `/`, DEL, U+2028, emoji — verbatim.
    static func writeString(_ s: String, into out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar.value {
            case 0x22: out += "\\\""
            case 0x5C: out += "\\\\"
            case 0x08: out += "\\b"
            case 0x0C: out += "\\f"
            case 0x0A: out += "\\n"
            case 0x0D: out += "\\r"
            case 0x09: out += "\\t"
            case 0..<0x20:
                let hex = String(scalar.value, radix: 16)
                out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
            default: out.unicodeScalars.append(scalar)
            }
        }
        out += "\""
    }

    /// ECMAScript `Number::toString` (radix 10) as `JSON.stringify` uses it: shortest
    /// round-trip digits; plain notation for 1e-7 < |x| < 1e21, else `d.ddde±x`;
    /// `-0` → `0`; non-finite → `null`.
    static func javaScriptNumber(_ d: Double) -> String {
        guard d.isFinite else { return "null" }
        if d == 0 { return "0" }
        // Swift's description is also the shortest round-trip form: "123.456", "1e-07", "1.5e+20".
        var text = "\(abs(d))".lowercased()
        var exp10 = 0
        if let e = text.firstIndex(of: "e") {
            exp10 = Int(text[text.index(after: e)...]) ?? 0
            text = String(text[..<e])
        }
        var intPart = text, fracPart = ""
        if let dot = text.firstIndex(of: ".") {
            intPart = String(text[..<dot])
            fracPart = String(text[text.index(after: dot)...])
        }
        var digits = intPart + fracPart
        var n = intPart.count + exp10 // value = 0.digits × 10^n
        let leading = digits.prefix { $0 == "0" }.count
        digits.removeFirst(leading)
        n -= leading
        while digits.hasSuffix("0") { digits.removeLast() }
        let k = digits.count
        let sign = d < 0 ? "-" : ""
        if k <= n && n <= 21 { return sign + digits + String(repeating: "0", count: n - k) }
        if 0 < n && n <= 21 { return sign + digits.prefix(n) + "." + digits.dropFirst(n) }
        if -6 < n && n <= 0 { return sign + "0." + String(repeating: "0", count: -n) + digits }
        let e = n - 1
        let mantissa = k == 1 ? digits : digits.prefix(1) + "." + digits.dropFirst(1)
        return sign + mantissa + "e" + (e < 0 ? "-" : "+") + String(abs(e))
    }
}

/// The approval digest: SHA-256 (lower-case hex) of the canonical JSON of
/// `{"kind": <kind>, "payload": <payload>}` — what the app echoes back on a decision and
/// may recompute to check that what it shows is what will be sent.
public enum ApprovalDigest {
    public static func canonicalJSON(kind: String, payload: JSONValue) -> String {
        JSONValue.object(["kind": .string(kind), "payload": payload]).canonicalJSON
    }

    public static func digest(kind: String, payload: JSONValue) -> String {
        SHA256.hash(data: Data(canonicalJSON(kind: kind, payload: payload).utf8)).map { byte in
            let h = String(byte, radix: 16)
            return h.count == 1 ? "0" + h : h
        }.joined()
    }

    /// 64 lower-case hex characters.
    public static func isWellFormed(_ digest: String) -> Bool {
        digest.utf8.count == 64 && digest.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }
}
