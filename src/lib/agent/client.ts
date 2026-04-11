import { invoke } from "@tauri-apps/api/core";

export const agentApi = {
  /** Inline edit: replace selected text based on instruction */
  edit: (noteId: string, selection: string, prompt: string) =>
    invoke<string>("agent_edit", { noteId, selection, prompt }),

  /** Chat: conversational exchange with optional document context */
  chat: (message: string, noteId?: string) =>
    invoke<{ message: string; session_id: string | null; is_error: boolean }>(
      "agent_chat",
      { message, noteId },
    ),

  /** Transform: convert document to a different content type */
  transform: (noteId: string, targetType: string) =>
    invoke<string>("agent_transform", { noteId, targetType }),

  /** Generate: create new content from a prompt */
  generate: (prompt: string, contentType?: string) =>
    invoke<string>("agent_generate", { prompt, contentType }),
};

export const configApi = {
  getStatus: () =>
    invoke<{
      matrix: { configured: boolean; homeserver: string; user: string };
      notion: { configured: boolean };
      anthropic: { configured: boolean };
      google: { primary: string; agent: string };
    }>("get_config_status"),

  checkGoogleAuth: () =>
    invoke<{
      primary: { account: string; authenticated: boolean };
      agent: { account: string; authenticated: boolean };
    }>("google_check_auth"),

  setAnthropicKey: (key: string) =>
    invoke<void>("set_anthropic_key", { key }),
};
