import Foundation

/// The only kind of `URLSession` PrismKit uses: ephemeral, no cookies, no cache, no stored
/// credentials, and it NEVER follows a redirect (so a bearer token, code or verifier can
/// never be forwarded to another host — a 3xx is returned to the caller, who refuses it).
public enum PrismURLSession {
    /// Create one and keep it: a `URLSession` retains its delegate until invalidated.
    public static func make(requestTimeout: TimeInterval = 30, configure: (@Sendable (URLSessionConfiguration) -> Void)? = nil) -> URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.urlCache = nil
        c.urlCredentialStorage = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = requestTimeout
        c.waitsForConnectivity = false
        configure?(c)
        return URLSession(configuration: c, delegate: RedirectRefuser(), delegateQueue: nil)
    }
}

/// Refuses every HTTP redirect.
public final class RedirectRefuser: NSObject, URLSessionTaskDelegate, Sendable {
    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// A short reason for a `URLError` that never includes the URL.
public func prismSanitizedReason(_ error: any Error) -> String {
    if let e = error as? URLError {
        switch e.code {
        case .timedOut: return "timed out"
        case .cannotFindHost, .dnsLookupFailed: return "host not found"
        case .cannotConnectToHost: return "connection refused"
        case .notConnectedToInternet: return "offline"
        case .networkConnectionLost: return "connection lost"
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected, .clientCertificateRequired:
            return "secure connection failed"
        case .appTransportSecurityRequiresSecureConnection: return "blocked by App Transport Security"
        default: return "network error \(e.code.rawValue)"
        }
    }
    return "network error"
}
