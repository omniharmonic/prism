/** The stable Hermes session for one owner + source (lost create responses are recovered by id). */
import { hermes, HermesError } from "./hermes-client";
import { sha256 } from "./store";

export async function ensureSourceSession(owner: string, sourceId: string, title: string, threadId: string | null = null): Promise<string> {
  const id = threadId ?? `omni-proactive-${sha256(`${owner}:${sourceId}`).slice(0, 32)}`;
  try {
    await hermes.getSession(id);
  } catch (e) {
    if (!(e instanceof HermesError && e.code === "not_found")) throw e;
    try {
      await hermes.createSession({ id, title: `${title.slice(0, 80)} ${sha256(`${owner}:${sourceId}`).slice(0, 8)}` });
    } catch (createError) {
      if (!(createError instanceof HermesError && createError.hermesCode === "session_exists")) throw createError;
      await hermes.getSession(id);
    }
  }
  return id;
}
