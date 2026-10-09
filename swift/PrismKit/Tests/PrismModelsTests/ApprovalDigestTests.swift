import Foundation
import PrismModels
import XCTest

final class ApprovalDigestTests: XCTestCase {
    struct Vector: Decodable {
        let name: String
        let kind: String
        let payload: JSONValue
        let canonical: String
        let digest: String
    }

    func vectors() throws -> [Vector] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "approval-digest-vectors", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode([Vector].self, from: Data(contentsOf: url))
    }

    /// The vectors were produced by RUNNING the server's `canonicalJson` / `approvalDigest`.
    func testByteIdenticalToTheServer() throws {
        let all = try vectors()
        XCTAssertGreaterThanOrEqual(all.count, 20)
        for v in all {
            let canonical = ApprovalDigest.canonicalJSON(kind: v.kind, payload: v.payload)
            XCTAssertEqual(Array(canonical.utf8), Array(v.canonical.utf8), "canonical bytes: \(v.name)")
            XCTAssertEqual(ApprovalDigest.digest(kind: v.kind, payload: v.payload), v.digest, "digest: \(v.name)")
            XCTAssertTrue(ApprovalDigest.isWellFormed(v.digest))
        }
    }

    func testKeyOrderDoesNotMatterButContentDoes() throws {
        let all = Dictionary(uniqueKeysWithValues: try vectors().map { ($0.name, $0) })
        XCTAssertEqual(all["email-basic"]!.digest, all["email-keys-out-of-order"]!.digest)
        XCTAssertNotEqual(all["email-with-cc"]!.digest, all["email-recipient-order-matters"]!.digest, "list order is content")
        let a: JSONValue = ["to": ["kevin@example.com"], "subject": "Buoy spec", "body": "x"]
        let b: JSONValue = ["to": ["kevin@example.com"], "subject": "Buoy spec", "body": "x "]
        XCTAssertNotEqual(ApprovalDigest.digest(kind: "email", payload: a), ApprovalDigest.digest(kind: "email", payload: b))
        XCTAssertNotEqual(ApprovalDigest.digest(kind: "email", payload: a), ApprovalDigest.digest(kind: "message", payload: a), "the kind is part of the digest")
    }

    func testAnApprovalDecodedFromTheWireRecomputesItsOwnDigest() throws {
        for v in try vectors() where ["email", "email-reply", "message", "calendar-invite", "tweet", "wallet-proposal"].contains(v.kind) {
            let wire: JSONValue = [
                "id": "apr_0123456789abcdef01234567", "threadId": "omni_abc", "kind": .string(v.kind), "payload": v.payload, "digest": .string(v.digest),
                "summary": "test", "status": "pending", "createdAt": "2026-10-08T15:04:00.000Z", "expiresAt": "2026-10-09T15:04:00.000Z",
                "decidedAt": nil, "result": nil, "supersededBy": nil, "revises": nil, "executor": ["name": "proton-send", "available": true, "enabled": false],
            ]
            let approval = try PrismJSON.decoder().decode(Approval.self, from: PrismJSON.encoder().encode(wire))
            XCTAssertEqual(approval.computedDigest, v.digest, v.name)
            XCTAssertTrue(approval.digestMatchesPayload, v.name)
            XCTAssertTrue(approval.isPending)
            XCTAssertEqual(approval.executor?.canSend, false)
        }
    }

    func testJavaScriptNumberFormatting() {
        let cases: [(JSONValue, String)] = [
            (.int(0), "0"), (.int(-1), "-1"), (.double(-0.0), "0"), (.double(1.0), "1"), (.double(100), "100"), (.double(0.1), "0.1"),
            (.double(1e21), "1e+21"), (.double(1e20), "100000000000000000000"), (.double(1e-7), "1e-7"), (.double(0.000001), "0.000001"),
            (.double(1.5e-10), "1.5e-10"), (.double(123456.789), "123456.789"), (.double(5e-324), "5e-324"), (.double(.infinity), "null"), (.double(.nan), "null"),
            (.int(9_007_199_254_740_993), "9007199254740992"), (.int(Int64.max), "9223372036854776000"),
        ]
        for (value, expected) in cases { XCTAssertEqual(value.canonicalJSON, expected) }
    }

    func testJSONValueRoundTripsAndAccessors() throws {
        let raw = #"{"s":"x","i":3,"d":1.5,"b":true,"n":null,"a":["p","q"],"o":{"k":[1,2]}}"#
        let v = try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
        XCTAssertEqual(v["s"]?.stringValue, "x")
        XCTAssertEqual(v["i"], .int(3))
        XCTAssertEqual(v["i"]?.doubleValue, 3)
        XCTAssertEqual(v["d"], .double(1.5))
        XCTAssertEqual(v["b"]?.boolValue, true)
        XCTAssertEqual(v["n"]?.isNull, true)
        XCTAssertEqual(v["a"]?.stringArrayValue, ["p", "q"])
        XCTAssertNil(v["o"]?["k"]?.stringArrayValue)
        XCTAssertEqual(v["o"]?["k"]?[1]?.intValue, 2)
        XCTAssertNil(v["missing"])
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(v)), v)
        XCTAssertEqual(v.canonicalJSON, #"{"a":["p","q"],"b":true,"d":1.5,"i":3,"n":null,"o":{"k":[1,2]},"s":"x"}"#)
    }
}
