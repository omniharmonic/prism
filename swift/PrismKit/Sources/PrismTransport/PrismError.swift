import Foundation

/// A non-2xx answer the server gave, with its `{error, detail}` body when it had one.
public struct ServerFailure: Sendable, Equatable {
    public let status: Int
    /// The server's `error` code (`conflict`, `digest_mismatch`, `forbidden`, …), if the
    /// body was `{error: <string>}`.
    public let code: String?
    public let detail: String?
    /// The raw body (bounded by the transport's response cap), for route-specific fields
    /// such as a 409's `turnId`.
    public let body: Data

    public init(status: Int, code: String?, detail: String?, body: Data) {
        self.status = status
        self.code = code
        self.detail = detail
        self.body = body
    }
}

/// The request was sent (or may have been) and its effect is not known: a 5xx, a
/// timeout, or a connection lost mid-flight. NEVER blindly retry a non-idempotent call
/// after this — re-read the resource, or retry with the SAME `Idempotency-Key`.
public struct OutcomeUnknown: Sendable, Equatable {
    /// The HTTP status, when an answer arrived (5xx).
    public let status: Int?
    /// The server's `error` code, when the 5xx carried one (`hermes_unavailable`, …).
    public let code: String?
    public let reason: String
    public let body: Data

    public init(status: Int?, code: String?, reason: String, body: Data = Data()) {
        self.status = status
        self.code = code
        self.reason = reason
        self.body = body
    }
}

public enum PrismError: Error, Sendable, Equatable {
    /// Refused locally; nothing was sent (bad path, malformed idempotency key, …).
    case invalidRequest(String)
    /// No token is stored; nothing was sent. Show the sign-in screen (never start a
    /// sign-in without the person asking).
    case notSignedIn
    /// 401, and `/auth/me` confirmed the token is dead. It has been forgotten and the
    /// signed-out handler has run. Show the sign-in screen.
    case signedOut
    /// 401, but the token is not confirmed dead (alive, unknown, or no longer the current
    /// token). Nothing was forgotten.
    case unauthorized
    /// 403 (`forbidden`, `csrf_refused`, `human_origin_required`, …).
    case forbidden(ServerFailure)
    /// 409 with the server's `error` code (`conflict`, `digest_mismatch`,
    /// `already_decided`, `in_progress`).
    case conflict(ServerFailure)
    /// Any other 4xx (400 `bad_request`, 404 `not_found`, 410 `expired`, 415, 422, 429 …).
    case rejected(ServerFailure)
    /// The server answered a redirect; it was not followed and no bearer left the origin.
    case redirectRefused(status: Int)
    /// The server could not be reached; the request was not delivered.
    case unreachable(String)
    /// 5xx / timeout / connection lost: see ``OutcomeUnknown``.
    case outcomeUnknown(OutcomeUnknown)
    /// A 2xx whose body is not what the route documents.
    case decoding(String)
    /// The token store failed (status only).
    case tokenStore(String)

    /// The server's `error` code, whichever case carries it.
    public var serverCode: String? {
        switch self {
        case .forbidden(let f), .conflict(let f), .rejected(let f): return f.code
        case .outcomeUnknown(let u): return u.code
        default: return nil
        }
    }

    public var httpStatus: Int? {
        switch self {
        case .forbidden(let f), .conflict(let f), .rejected(let f): return f.status
        case .outcomeUnknown(let u): return u.status
        case .redirectRefused(let s): return s
        case .signedOut, .unauthorized: return 401
        default: return nil
        }
    }
}

/// `Idempotency-Key`: 8–200 characters of `[A-Za-z0-9._:-]` (the server's
/// `IDEMPOTENCY_KEY_RE`). Keep and RESEND the same key when retrying the same action.
public struct IdempotencyKey: Sendable, Hashable, CustomStringConvertible {
    public let value: String

    public init?(_ value: String) {
        let n = value.utf8.count
        guard n >= 8, n <= 200, value.utf8.allSatisfy({ c in
            (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x2E || c == 0x5F || c == 0x3A || c == 0x2D
        }) else { return nil }
        self.value = value
    }

    /// A fresh random key.
    public static func random() -> IdempotencyKey {
        IdempotencyKey(UUID().uuidString.lowercased())!
    }

    public var description: String { value }
}
