/**
 * The collab editor schema version, alone in a module with no imports: the app shell
 * (the `X-Prism-Editor-Schema` request header, the background document sync) needs the
 * number at boot without loading the editor. History of the versions: `collabSchema.ts`,
 * which re-exports this constant (bump it there in the comment, here in the value).
 */
export const COLLAB_SCHEMA_VERSION = 6;
