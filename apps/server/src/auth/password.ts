/**
 * Password hashing with scrypt (node:crypto — no deps). Each password gets a
 * random 16-byte salt; we store `scrypt$N$salt$hash` (all hex/base64) and verify
 * in constant time. scrypt is memory-hard, a sound choice for at-rest password
 * storage on a single home server.
 */
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

const KEYLEN = 64;
const COST = 16384; // 2^14 — solid for interactive login on a home server

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N: COST });
  return `scrypt$${COST}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const cost = Number(parts[1]);
  const salt = Buffer.from(parts[2]!, "base64");
  const expected = Buffer.from(parts[3]!, "base64");
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length, { N: cost });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Basic password policy. Returns an error message, or null if acceptable. */
export function passwordProblem(pw: string): string | null {
  if (typeof pw !== "string" || pw.length < 10) return "Password must be at least 10 characters.";
  if (pw.length > 200) return "Password is too long.";
  return null;
}
