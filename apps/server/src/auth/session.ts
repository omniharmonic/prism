/**
 * Session cookies for signed-in users. The cookie carries an opaque, random
 * session id; the authoritative record (email, expiry) lives in SQLite, so a
 * session is revocable server-side by deleting its row. httpOnly + SameSite=Lax
 * + Secure (on https) keep it out of JS and off cross-site requests.
 */
import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { config } from "../config";
import { createSession, getSession, destroySession, ensureUser, type Session } from "../db";

const COOKIE = "prism_session";
const TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export function startSession(c: Context, email: string): void {
  ensureUser(email);
  const id = randomBytes(32).toString("base64url");
  createSession(id, email, TTL_MS);
  setCookie(c, COOKIE, id, {
    httpOnly: true,
    secure: config.appOrigin.startsWith("https"),
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(TTL_MS / 1000),
  });
}

export function readSession(c: Context): Session | null {
  const id = getCookie(c, COOKIE);
  if (!id) return null;
  return getSession(id);
}

export function endSession(c: Context): void {
  const id = getCookie(c, COOKIE);
  if (id) destroySession(id);
  deleteCookie(c, COOKIE, { path: "/" });
}
