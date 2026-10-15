import Foundation
import PrismModels
import PrismTransport

/// Item cards (docs/omni-module.md § Item cards). `choose` / `instruct`: one key per press; resend
/// the SAME key only after an unclear outcome (`PrismError.outcomeUnknown`) — the server then replays.
/// Nothing here retries on its own.
public extension OmniClient {
    func cards(section: CardSection? = nil) async throws -> CardList {
        try await transport.send(.get("\(Self.base)/cards", query: section.map { [URLQueryItem(name: "section", value: $0.rawValue)] } ?? []))
    }
    func card(_ id: String) async throws -> OmniCard {
        let answer: CardAnswer = try await transport.send(.get(try Self.cardPath(id)))
        return answer.card
    }
    func chooseCardOption(_ id: String, optionID: String, idempotencyKey: IdempotencyKey) async throws -> CardActionResult {
        struct Body: Encodable { let optionId: String }
        return try await transport.send(.json("POST", "\(try Self.cardPath(id))/choose", body: Body(optionId: optionID), idempotencyKey: idempotencyKey))
    }
    func instructCard(_ id: String, text: String, idempotencyKey: IdempotencyKey) async throws -> CardActionResult {
        struct Body: Encodable { let text: String }
        return try await transport.send(.json("POST", "\(try Self.cardPath(id))/instruct", body: Body(text: text), idempotencyKey: idempotencyKey))
    }
    func snoozeCard(_ id: String, until: Date) async throws -> OmniCard {
        struct Body: Encodable { let until: Int64 }
        let answer: CardAnswer = try await transport.send(.json("POST", "\(try Self.cardPath(id))/snooze", body: Body(until: Int64((until.timeIntervalSince1970 * 1000).rounded()))))
        return answer.card
    }
    func dismissCard(_ id: String, reason: CardDismissReason) async throws -> OmniCard {
        struct Body: Encodable { let reason: CardDismissReason }
        let answer: CardAnswer = try await transport.send(.json("POST", "\(try Self.cardPath(id))/dismiss", body: Body(reason: reason)))
        return answer.card
    }
}

private struct CardAnswer: Decodable { let card: OmniCard }

extension OmniClient {
    fileprivate static func cardPath(_ id: String) throws -> String { "\(base)/cards/\(try segment(id))" }
}
