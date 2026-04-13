import { useState, useMemo } from "react";
import { X, Send, Search, User } from "lucide-react";
import { useNotes } from "../../app/hooks/useParachute";
import { useQuery } from "@tanstack/react-query";
import { matrixApi } from "../../lib/matrix/client";
import { getPlatformConfig, type Platform } from "../../lib/matrix/bridge-map";
import type { Note } from "../../lib/types";
import type { MatrixRoom } from "../../lib/matrix/types";

interface ComposeMessageProps {
  onClose: () => void;
}

// Channels we can extract from a person's metadata
const CHANNEL_KEYS: { key: string; platform: Platform }[] = [
  { key: "whatsapp", platform: "whatsapp" },
  { key: "telegram", platform: "telegram" },
  { key: "discord", platform: "discord" },
  { key: "signal", platform: "signal" },
  { key: "imessage", platform: "imessage" },
  { key: "email", platform: "email" },
  { key: "instagram", platform: "instagram" },
  { key: "messenger", platform: "messenger" },
  { key: "twitter", platform: "twitter" },
  { key: "linkedin", platform: "linkedin" },
  { key: "matrix", platform: "matrix" },
];

interface PersonChannel {
  platform: Platform;
  label: string;
  color: string;
  handle: string;
}

function extractChannels(person: Note): PersonChannel[] {
  const meta = person.metadata || {};
  const channels: PersonChannel[] = [];
  for (const { key, platform } of CHANNEL_KEYS) {
    const handle = meta[key] as string | undefined;
    if (handle) {
      const config = getPlatformConfig(platform);
      channels.push({
        platform,
        label: config.label,
        color: config.color,
        handle,
      });
    }
  }
  return channels;
}

function getPersonName(person: Note): string {
  const meta = person.metadata || {};
  if (meta.name && typeof meta.name === "string") return meta.name;
  if (person.path) {
    const parts = person.path.split("/");
    return parts[parts.length - 1].replace(/\.\w+$/, "");
  }
  return person.id.slice(0, 8);
}

export function ComposeMessage({ onClose }: ComposeMessageProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPerson, setSelectedPerson] = useState<Note | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<PersonChannel | null>(null);
  const [messageBody, setMessageBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch people from the vault
  const { data: people } = useNotes({ tag: "person" });

  // Fetch Matrix rooms to match person -> room
  const { data: rooms } = useQuery({
    queryKey: ["matrix", "rooms"],
    queryFn: matrixApi.getRooms,
    retry: 1,
  });

  // Filter people by search
  const filteredPeople = useMemo(() => {
    if (!people || searchQuery.length === 0) return people || [];
    const q = searchQuery.toLowerCase();
    return people.filter((p) => {
      const name = getPersonName(p).toLowerCase();
      return name.includes(q);
    });
  }, [people, searchQuery]);

  // Get channels for selected person
  const channels = useMemo(() => {
    if (!selectedPerson) return [];
    return extractChannels(selectedPerson);
  }, [selectedPerson]);

  // Find the Matrix room matching the selected person + channel
  const matchedRoom = useMemo((): MatrixRoom | null => {
    if (!selectedPerson || !selectedChannel || !rooms) return null;
    const personName = getPersonName(selectedPerson).toLowerCase();
    // Try to find a DM room on the selected platform with a matching name
    return rooms.find((r) => {
      if (r.platform !== selectedChannel.platform) return false;
      if (!r.is_dm) return false;
      return r.name.toLowerCase().includes(personName);
    }) || rooms.find((r) => {
      // Fallback: any room on that platform containing the person's name
      if (r.platform !== selectedChannel.platform) return false;
      return r.name.toLowerCase().includes(personName);
    }) || null;
  }, [selectedPerson, selectedChannel, rooms]);

  const handleSelectPerson = (person: Note) => {
    setSelectedPerson(person);
    setSelectedChannel(null);
    setSearchQuery("");
    setError(null);
  };

  const handleSend = async () => {
    if (!matchedRoom || !messageBody.trim()) return;
    setSending(true);
    setError(null);
    try {
      await matrixApi.sendMessage(matchedRoom.room_id, messageBody.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
    >
      <div
        className="glass-elevated rounded-xl w-[560px] flex flex-col"
        style={{ height: "min(600px, 85vh)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3"
          style={{ borderBottom: "1px solid var(--glass-border)" }}
        >
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Compose Message
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--glass-hover)]"
          >
            <X size={16} style={{ color: "var(--text-muted)" }} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          {/* Person selector */}
          <div>
            <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--text-muted)" }}>
              To
            </label>
            {selectedPerson ? (
              <div
                className="flex items-center gap-2 px-3 py-2 rounded-lg"
                style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }}
              >
                <User size={14} style={{ color: "var(--text-secondary)" }} />
                <span className="text-sm flex-1" style={{ color: "var(--text-primary)" }}>
                  {getPersonName(selectedPerson)}
                </span>
                <button
                  onClick={() => { setSelectedPerson(null); setSelectedChannel(null); }}
                  className="p-0.5 rounded hover:bg-[var(--glass-hover)]"
                >
                  <X size={12} style={{ color: "var(--text-muted)" }} />
                </button>
              </div>
            ) : (
              <div className="relative">
                <div
                  className="flex items-center gap-2 px-3 rounded-lg"
                  style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }}
                >
                  <Search size={13} style={{ color: "var(--text-muted)" }} />
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search people..."
                    autoFocus
                    className="flex-1 bg-transparent py-2 text-sm outline-none"
                    style={{ color: "var(--text-primary)" }}
                  />
                </div>
                {/* Dropdown results */}
                {searchQuery.length > 0 && filteredPeople.length > 0 && (
                  <div
                    className="absolute top-full left-0 right-0 mt-1 rounded-lg overflow-hidden z-50 max-h-72 overflow-auto"
                    style={{ background: "var(--bg-elevated)", border: "1px solid var(--glass-border)", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}
                  >
                    {filteredPeople.slice(0, 30).map((person) => (
                      <button
                        key={person.id}
                        onClick={() => handleSelectPerson(person)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-[var(--glass-hover)] transition-colors"
                        style={{ color: "var(--text-primary)" }}
                      >
                        <User size={13} style={{ color: "var(--text-muted)" }} />
                        {getPersonName(person)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Channel picker */}
          {selectedPerson && (
            <div>
              <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--text-muted)" }}>
                Channel
              </label>
              {channels.length === 0 ? (
                <div className="text-xs px-1" style={{ color: "var(--text-muted)" }}>
                  No messaging channels found in this person's metadata.
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {channels.map((ch) => (
                    <button
                      key={ch.platform}
                      onClick={() => setSelectedChannel(ch)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                      style={{
                        background: selectedChannel?.platform === ch.platform
                          ? `color-mix(in srgb, ${ch.color} 25%, transparent)`
                          : "var(--glass)",
                        border: `1px solid ${selectedChannel?.platform === ch.platform ? ch.color : "var(--glass-border)"}`,
                        color: selectedChannel?.platform === ch.platform ? ch.color : "var(--text-secondary)",
                      }}
                    >
                      {ch.label}
                      <span className="opacity-60">{ch.handle}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Room match indicator */}
          {selectedChannel && (
            <div className="text-xs px-1" style={{ color: matchedRoom ? "var(--color-success)" : "var(--color-warning)" }}>
              {matchedRoom
                ? `Will send via: ${matchedRoom.name}`
                : "No matching Matrix room found for this person and channel."}
            </div>
          )}

          {/* Message body */}
          {selectedPerson && selectedChannel && (
            <div>
              <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--text-muted)" }}>
                Message
              </label>
              <textarea
                value={messageBody}
                onChange={(e) => setMessageBody(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type your message..."
                rows={4}
                className="w-full resize-none rounded-lg px-3 py-2 text-sm outline-none"
                style={{
                  background: "var(--glass)",
                  border: "1px solid var(--glass-border)",
                  color: "var(--text-primary)",
                }}
              />
              <div className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                Press {navigator.platform.includes("Mac") ? "\u2318" : "Ctrl"}+Enter to send
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="text-xs px-1" style={{ color: "var(--color-danger)" }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-5 py-3"
          style={{ borderTop: "1px solid var(--glass-border)" }}
        >
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs hover:bg-[var(--glass-hover)] transition-colors"
            style={{ color: "var(--text-secondary)" }}
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={!matchedRoom || !messageBody.trim() || sending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
            style={{ background: "var(--color-accent)", color: "white" }}
          >
            <Send size={12} />
            {sending ? "Sending..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
