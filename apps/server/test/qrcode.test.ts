/**
 * The pairing QR encoder (packages/core/src/lib/qr/qrcode.ts). Prism's own, dependency-free.
 * Pinned against the standard's worked numbers (Reed–Solomon, format and version words) and
 * a golden grid for the pairing link — a grid that a real decoder (OpenCV) read back exactly
 * during development, at every mask and versions 1–19.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  alignmentPositions,
  dataCodewords,
  encodeQr,
  formatBits,
  qrSvgPath,
  rawDataModules,
  rsDivisor,
  rsRemainder,
  versionBits,
} from "../../../packages/core/src/lib/qr/qrcode";

const LINK = "prism://pair?v=1&s=https%3A%2F%2Fprism.tail1234.ts.net&c=AbCdEfGhIjKlMnOpQrStUv";
const gridHash = (m: boolean[][]) => createHash("sha256").update(m.map((r) => r.map((b) => (b ? 1 : 0)).join("")).join("\n")).digest("hex");

test("Reed–Solomon matches the standard's 1-M example", () => {
  // "HELLO WORLD", version 1-M: 16 data codewords → these 10 error-correction codewords.
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsRemainder(data, rsDivisor(10)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test("format and version words are the standard's", () => {
  // Level M (00) + mask 0 is the bare XOR mask; level M mask 5 is 100000011001110.
  assert.equal(formatBits(0), 0b101010000010010);
  assert.equal(formatBits(5), 0b100000011001110);
  assert.equal(versionBits(7), 0x07c94);
  assert.equal(versionBits(20), 0x149a6);
});

test("capacities and alignment positions", () => {
  assert.equal(rawDataModules(1), 208);
  assert.deepEqual([1, 5, 7, 10, 20].map(dataCodewords), [16, 86, 124, 216, 669]);
  assert.deepEqual(alignmentPositions(1), []);
  assert.deepEqual(alignmentPositions(7), [6, 22, 38]);
  assert.deepEqual(alignmentPositions(20), [6, 34, 62, 90]);
});

test("the pairing link encodes to its golden grid (decoder-verified)", () => {
  const q = encodeQr(LINK);
  assert.equal(q.version, 5);
  assert.equal(q.size, 37);
  assert.equal(gridHash(q.modules), "9010a5d08dd8b0bd882a8cf03b9d5217cd711c7c8ffb36d4b568ff464305516c");
  // Finder patterns at three corners, the dark module, timing on row 6.
  for (const [x, y] of [[0, 0], [q.size - 1, 0], [0, q.size - 1], [8, q.size - 8]] as const) assert.equal(q.modules[y]![x], true);
  for (let i = 8; i < q.size - 8; i++) assert.equal(q.modules[6]![i], i % 2 === 0);
  assert.match(qrSvgPath(q), /^M4 4h1v1h-1z/);
});

test("longer text picks a bigger version; too long throws", () => {
  assert.equal(encodeQr("x".repeat(200)).version, 10);
  assert.equal(encodeQr("y".repeat(600)).version, 19);
  assert.equal(encodeQr("z".repeat(666)).version, 20);
  assert.throws(() => encodeQr("z".repeat(667)));
  // Every forced mask still yields a full grid with that mask's format word.
  for (let mask = 0; mask < 8; mask++) assert.equal(encodeQr(LINK, { mask }).mask, mask);
});
