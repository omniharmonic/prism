/**
 * The browser-editable `.env` writer behind `PUT /acl/server/config` — kept
 * pure so the injection guarantees are unit-tested (test/env-edit.test.ts).
 *
 * Deliberately tiny: only NON-SECRET keys whose change cannot redirect a
 * credential or sign-in link may be listed (docs/credentials.md). APP_ORIGIN and
 * RESEND_API_KEY were removed for that reason. Every value goes through ONE
 * central check (`isSafeEnvValue`) before its per-key validator, so a newline /
 * CR / NUL / any control char can never add a line (`OWNER_EMAIL=…`) that
 * `node --env-file` would honour.
 */

/** `Name <addr@domain.tld>` or bare `addr@domain.tld`. No quotes, `#`, `$`,
 *  backslashes or control chars (all meaningful to the env parser). */
const EMAIL = "[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\\.[A-Za-z0-9-]{1,63})*\\.[A-Za-z]{2,24}";
const MAGIC_FROM_RE = new RegExp(`^(?:${EMAIL}|[A-Za-z0-9][A-Za-z0-9 ._-]{0,63} <${EMAIL}>)$`);

export const EDITABLE_ENV: Record<string, (v: string) => boolean> = {
  MAGIC_FROM: (v) => v.length <= 200 && MAGIC_FROM_RE.test(v),
};

/** Central guard for EVERY editable value: printable, no line breaks/NUL/control
 *  chars (incl. U+2028/2029 and DEL), no leading/trailing whitespace, bounded. */
export function isSafeEnvValue(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > 500) return false;
  if (v !== v.trim()) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v);
}

export function validateEnvEdit(key: unknown, value: unknown): { ok: true; key: string; value: string } | { ok: false; error: "not_editable" | "bad_value" } {
  if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(EDITABLE_ENV, key)) return { ok: false, error: "not_editable" };
  if (!isSafeEnvValue(value) || !EDITABLE_ENV[key]!(value)) return { ok: false, error: "bad_value" };
  return { ok: true, key, value };
}

/** Replace every `KEY=…` line (or append one). The replacement is a FUNCTION so
 *  `$&` / `$'` / `` $` `` in the value are literal, never expanded. Throws if
 *  the value isn't safe — the writer re-checks even if a caller forgot. */
export function applyEnvEdit(raw: string, key: string, value: string): string {
  const v = validateEnvEdit(key, value);
  if (!v.ok) throw new Error(`refusing to write ${key}: ${v.error}`);
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "gm");
  if (re.test(raw)) return raw.replace(re, () => line);
  return `${raw.replace(/\n?$/, "\n")}${line}\n`;
}
