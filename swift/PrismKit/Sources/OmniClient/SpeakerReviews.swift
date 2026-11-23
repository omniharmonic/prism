import Foundation
import PrismModels
import PrismTransport

/// Speaker reviews ("Confirm speakers"; docs/omni-module.md § Speaker reviews). An answer replaces
/// the row's earlier answer, so a retry after an unclear outcome is harmless.
public extension OmniClient {
    /// `open`: open reviews only; `all`: also done ones from the last 24 hours.
    func speakerReviews(openOnly: Bool = false) async throws -> SpeakerReviewList {
        try await transport.send(.get("\(Self.base)/speaker-reviews", query: [URLQueryItem(name: "status", value: openOnly ? "open" : "all")]))
    }
    func speakerReview(_ id: String) async throws -> SpeakerReview {
        let answer: SpeakerReviewAnswer = try await transport.send(.get(try Self.speakerPath(id)))
        return answer.review
    }
    /// The row's clip (AAC in an MP4 container, at most 600 KB).
    func speakerClip(_ id: String, rowID: String) async throws -> Data {
        let response: PrismResponse = try await transport.send(.get("\(try Self.speakerPath(id))/rows/\(try Self.segment(rowID))/clip"))
        guard response.header("Content-Type")?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces) == "audio/mp4",
              !response.body.isEmpty, response.body.count <= 600 * 1024 else {
            throw PrismError.decoding("The server returned an unsupported or oversized clip.")
        }
        return response.body
    }
    func answerSpeaker(_ id: String, rowID: String, choice: SpeakerReview.Choice, name: String? = nil, email: String? = nil) async throws -> SpeakerReview {
        struct Body: Encodable { let rowId: String; let choice: SpeakerReview.Choice; let name: String?; let email: String? }
        let answer: SpeakerReviewAnswer = try await transport.send(.json("POST", "\(try Self.speakerPath(id))/answers", body: Body(rowId: rowID, choice: choice, name: name, email: email)))
        return answer.review
    }
}

private struct SpeakerReviewAnswer: Decodable { let review: SpeakerReview }

extension OmniClient {
    fileprivate static func speakerPath(_ id: String) throws -> String { "\(base)/speaker-reviews/\(try segment(id))" }
}
