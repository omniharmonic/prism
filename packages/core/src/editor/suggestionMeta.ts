import { PluginKey } from "@tiptap/pm/state";

/**
 * The suggesting plugin's key. A transaction carrying it as meta is exempt from tracking
 * (review actions, programmatic rewrites that are not a person's edit). Kept in a module of
 * its own so editor code that never loads the live-collaboration stack can set it.
 */
export const suggestionKey = new PluginKey("suggestionMode");
export const SUGGESTION_UNTRACKED_META = suggestionKey;
