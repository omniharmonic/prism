import Foundation

/// JSON coding shared by the transport and the models: ISO-8601 dates with or without
/// fractional seconds.
public enum PrismJSON {
    public static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let s = try decoder.singleValueContainer().decode(String.self)
            if let date = parseDate(s) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not an ISO-8601 date"))
        }
        return d
    }

    public static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .custom { date, encoder in
            var c = encoder.singleValueContainer()
            try c.encode(date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
        }
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }

    public static func parseDate(_ s: String) -> Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(s)) ?? (try? Date.ISO8601FormatStyle().parse(s))
    }

    /// A decoding error without the offending values (bodies may hold private text).
    public static func describe(_ error: any Error) -> String {
        guard let e = error as? DecodingError else { return "invalid JSON" }
        func path(_ c: DecodingError.Context) -> String { c.codingPath.map(\.stringValue).joined(separator: ".") }
        switch e {
        case .keyNotFound(let k, let c): return "missing \(([path(c), k.stringValue].filter { !$0.isEmpty }).joined(separator: "."))"
        case .typeMismatch(_, let c): return "wrong type at \(path(c))"
        case .valueNotFound(_, let c): return "null at \(path(c))"
        case .dataCorrupted(let c): return "invalid value at \(path(c))"
        @unknown default: return "invalid JSON"
        }
    }
}
