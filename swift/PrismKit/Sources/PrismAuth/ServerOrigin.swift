import Foundation

/// Why a server address was refused.
public enum ServerOriginError: Error, Equatable, Sendable {
    case empty
    case notAURL
    case invalidHost
    case unsupportedScheme(String)
    /// Plain http is only allowed for 127.0.0.1 / localhost / [::1].
    case insecureScheme
    case hasUserInfo
    case hasQueryOrFragment
    case hasPath
    /// 1939 / 1940 on loopback are the Parachute hub / vault, never a Prism Server.
    case forbiddenPort(Int)
}

/// The ONE Prism Server origin a client talks to: `scheme://host[:port]`, validated and
/// normalised. Ported from `apps/client/src-tauri/src/origin.rs` (`ServerOrigin`).
///
/// Rules: `https` only, except `http` for a loopback host; no path (other than `/`),
/// query, fragment or userinfo; LDH host names, IPv4 or bracketed IPv6 only; the vault and
/// hub loopback ports are refused.
public struct ServerOrigin: Sendable, Hashable, CustomStringConvertible {
    /// `https://prism.example.com` or `http://127.0.0.1:8787` — no trailing slash.
    public let value: String
    public let scheme: String
    /// Lower-case host; an IPv6 literal keeps its brackets.
    public let host: String
    /// The explicit port, when one was given.
    public let port: Int?

    public static let forbiddenLoopbackPorts: Set<Int> = [1939, 1940]

    /// Plain-http loopback is a development affordance; an iOS release build refuses it
    /// (as the Tauri client does).
    public static var allowsHTTPLoopback: Bool {
        #if os(iOS) && !DEBUG
        return false
        #else
        return true
        #endif
    }

    public var description: String { value }

    public init(_ input: String) throws {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ServerOriginError.empty }
        // Refuse anything a lenient URL parser might "repair": spaces, control characters,
        // backslashes, non-ASCII (no IDNA here — enter the punycode form).
        guard trimmed.unicodeScalars.allSatisfy({ $0.isASCII && $0.value > 0x20 && $0.value != 0x7F && $0 != "\\" }) else {
            throw trimmed.contains("://") ? ServerOriginError.invalidHost : ServerOriginError.notAURL
        }
        guard let sep = trimmed.range(of: "://") else { throw ServerOriginError.notAURL }
        let scheme = trimmed[..<sep.lowerBound].lowercased()
        guard !scheme.isEmpty, scheme.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) || "+-.".unicodeScalars.contains($0) }) else {
            throw ServerOriginError.notAURL
        }
        var rest = String(trimmed[sep.upperBound...])
        if rest.contains("?") || rest.contains("#") { throw ServerOriginError.hasQueryOrFragment }
        // authority = up to the first "/"
        var path = ""
        if let slash = rest.firstIndex(of: "/") {
            path = String(rest[slash...])
            rest = String(rest[..<slash])
        }
        if rest.contains("@") { throw ServerOriginError.hasUserInfo }
        guard scheme == "https" || scheme == "http" else { throw ServerOriginError.unsupportedScheme(scheme) }
        if !(path.isEmpty || path == "/") { throw ServerOriginError.hasPath }

        // host[:port]
        var hostPart = rest
        var port: Int?
        if hostPart.hasPrefix("[") {
            guard let close = hostPart.firstIndex(of: "]") else { throw ServerOriginError.invalidHost }
            let after = hostPart[hostPart.index(after: close)...]
            if !after.isEmpty {
                guard after.hasPrefix(":") else { throw ServerOriginError.invalidHost }
                port = try Self.parsePort(after.dropFirst())
            }
            hostPart = String(hostPart[...close])
        } else if let colon = hostPart.lastIndex(of: ":") {
            port = try Self.parsePort(hostPart[hostPart.index(after: colon)...])
            hostPart = String(hostPart[..<colon])
        }
        var host = hostPart.lowercased()
        if host.hasSuffix("."), !host.hasPrefix("[") { host.removeLast() } // a trailing root dot is the same host
        guard Self.isValidHost(host) else { throw ServerOriginError.invalidHost }

        let loopback = host == "127.0.0.1" || host == "localhost" || host == "[::1]"
        if scheme == "http" {
            guard loopback, Self.allowsHTTPLoopback else { throw ServerOriginError.insecureScheme }
        }
        if loopback {
            let effective = port ?? (scheme == "https" ? 443 : 80)
            if Self.forbiddenLoopbackPorts.contains(effective) { throw ServerOriginError.forbiddenPort(effective) }
        }
        let value = "\(scheme)://\(host)" + (port.map { ":\($0)" } ?? "")
        // Parser-differential guard: Foundation must read the SAME host out of what we built.
        guard let check = URL(string: value + "/"), let checkedHost = check.host(percentEncoded: false)?.lowercased(),
              Self.stripBrackets(checkedHost) == Self.stripBrackets(host), check.user == nil, check.port == port
        else { throw ServerOriginError.invalidHost }
        self.value = value
        self.scheme = scheme
        self.host = host
        self.port = port
    }

    private static func parsePort(_ s: Substring) throws -> Int {
        guard !s.isEmpty, s.count <= 5, s.allSatisfy({ $0.isASCII && $0.isNumber }), let p = Int(s), (1...65535).contains(p) else {
            throw ServerOriginError.invalidHost
        }
        return p
    }

    private static func stripBrackets(_ h: String) -> String {
        h.hasPrefix("[") && h.hasSuffix("]") ? String(h.dropFirst().dropLast()) : h
    }

    private static func isValidHost(_ host: String) -> Bool {
        if host.hasPrefix("[") {
            guard host.hasSuffix("]") else { return false }
            let inner = host.dropFirst().dropLast()
            return inner.count >= 2 && inner.count <= 45 && inner.contains(":") && inner.allSatisfy { $0.isASCII && ($0.isHexDigit || $0 == ":" || $0 == ".") }
        }
        guard !host.isEmpty, host.utf8.count <= 253 else { return false }
        return host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { label in
            !label.isEmpty && label.utf8.count <= 63 && !label.hasPrefix("-") && !label.hasSuffix("-")
                && label.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x7A) || $0 == 0x2D }
        }
    }

    /// The port requests actually go to.
    public var effectivePort: Int { port ?? (scheme == "https" ? 443 : 80) }

    /// Is `url` on exactly this origin (scheme, host, effective port)? The bearer token is
    /// only ever attached when this is true.
    public func contains(_ url: URL) -> Bool {
        guard let s = url.scheme?.lowercased(), s == scheme, url.user == nil, url.password == nil,
              let h = url.host(percentEncoded: false)?.lowercased()
        else { return false }
        var candidate = h
        if candidate.hasSuffix(".") { candidate.removeLast() }
        guard Self.stripBrackets(candidate) == Self.stripBrackets(host) else { return false }
        return (url.port ?? (s == "https" ? 443 : 80)) == effectivePort
    }

    /// `origin + path (+ query)`. The path must be absolute; `.`/`..` segments, `//`, and
    /// backslashes are refused so a path can never climb or change the authority.
    public func url(path: String, query: [URLQueryItem] = []) throws -> URL {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("\\"), !path.contains("?"), !path.contains("#"),
              !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." })
        else { throw ServerOriginError.hasPath }
        var encodedPath = ""
        for scalar in path.unicodeScalars {
            if Self.pathAllowed.contains(scalar) { encodedPath.unicodeScalars.append(scalar) } else { encodedPath += FormEncoding.percentEncode(String(scalar)) }
        }
        var s = value + encodedPath
        if !query.isEmpty { s += "?" + FormEncoding.encode(query.map { ($0.name, $0.value ?? "") }) }
        guard let url = URL(string: s), contains(url) else { throw ServerOriginError.notAURL }
        return url
    }

    private static let pathAllowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~/:@!$&'()*+,;=")
}

/// `application/x-www-form-urlencoded` with strict percent-encoding (only RFC 3986
/// unreserved characters stay literal), used for query strings and the token POST.
public enum FormEncoding {
    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    public static func percentEncode(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
    }

    public static func encode(_ pairs: [(String, String)]) -> String {
        pairs.map { "\(percentEncode($0.0))=\(percentEncode($0.1))" }.joined(separator: "&")
    }

    /// Parse a form/query string: `+` is a space, `%XX` is decoded, order is kept.
    public static func decode(_ query: String) -> [(String, String)] {
        query.split(separator: "&", omittingEmptySubsequences: true).map { pair in
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let dec: (Substring) -> String = { raw in
                let spaced = raw.replacingOccurrences(of: "+", with: " ")
                return spaced.removingPercentEncoding ?? spaced
            }
            return (dec(parts[0]), parts.count > 1 ? dec(parts[1]) : "")
        }
    }
}
