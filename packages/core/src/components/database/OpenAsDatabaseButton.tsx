import { useState } from "react";
import { Table2 } from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useUIStore } from "../../app/stores/ui";
import { createDatabaseNote } from "./createDatabase";
import "./database.css";

/**
 * "Open as database" for a tag page: creates (or reopens) `Databases/<tag>`, a
 * database page over every note carrying the tag.
 */
export function OpenAsDatabaseButton({ tag }: { tag: string }) {
  const client = useVaultClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = `Databases/${tag.replace(/[\\/]/g, "-")}`;
  const open = async () => {
    setBusy(true);
    setError("");
    try {
      let note;
      try {
        note = await client.getNote(path);
      } catch {
        note = await createDatabaseNote(client, tag, path);
      }
      useUIStore.getState().openTab(note.id, path.split("/").pop()!, "database");
    } catch {
      setError("The database could not be created. You may not be able to create pages here.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4, marginLeft: "auto" }}>
      <button type="button" className="db-control focus-ring" disabled={busy} onClick={() => void open()}>
        <Table2 size={14} aria-hidden="true" /> {busy ? "Opening…" : "Open as database"}
      </button>
      {error && <span role="alert" className="db-error">{error}</span>}
    </span>
  );
}
