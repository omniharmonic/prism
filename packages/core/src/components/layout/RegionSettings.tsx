import { DATE_FORMAT_CHOICES, TIME_FORMAT_CHOICES, WEEK_START_CHOICES, setRegionPrefs, type DateFormatPref, type TimeFormatPref, type WeekStartPref } from "../../lib/datetime/preferences";
import { useRegionPrefs } from "../../lib/datetime/useRegionPrefs";
import { formatDate, formatTime, localeWeekStart } from "../../lib/datetime/format";

/**
 * Settings → Appearance → Language & region (NP-AX-09): start of week, date format and
 * 12/24-hour time. Every date in the app is written by `lib/datetime/format`, which reads
 * these. Stored on the device and carried to the person's other devices with the synced
 * preferences (favorites, recents) where the server supports it.
 */
const WEEK_LABEL: Record<WeekStartPref, string> = { system: "System locale", sunday: "Sunday", monday: "Monday" };
const DATE_LABEL: Record<DateFormatPref, string> = { system: "System", iso: "YYYY-MM-DD", dmy: "DD/MM/YYYY", mdy: "MM/DD/YYYY", long: "Oct 4, 2026" };
const TIME_LABEL: Record<TimeFormatPref, string> = { system: "System", "12": "12-hour", "24": "24-hour" };
const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const selectStyle = { background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" } as const;

function Choice<T extends string>({ label, value, choices, labels, onChange }: { label: string; value: T; choices: readonly T[]; labels: Record<T, string>; onChange: (next: T) => void }) {
  return (
    <div className="prism-settings__row">
      <span className="text-sm" style={{ color: "var(--text-primary)" }}>{label}</span>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)} className="h-7 rounded-md px-2 text-xs outline-none" style={selectStyle}>
        {choices.map((c) => <option key={c} value={c} style={{ background: "var(--bg-elevated)" }}>{labels[c]}</option>)}
      </select>
    </div>
  );
}

export function RegionSettings() {
  const prefs = useRegionPrefs();
  const now = new Date();
  const sample = `${formatDate(now, { year: "numeric", month: "short", day: "numeric" })} · ${formatTime(now, { hour: "numeric", minute: "2-digit" })}`;
  return (
    <section className="prism-settings__section" data-testid="region-settings">
      <h4>Language &amp; region</h4>
      <Choice label="Start week on" value={prefs.weekStart} choices={WEEK_START_CHOICES} labels={{ ...WEEK_LABEL, system: `System locale (${DAY[localeWeekStart()]})` }} onChange={(weekStart) => setRegionPrefs({ weekStart })} />
      <Choice label="Date format" value={prefs.dateFormat} choices={DATE_FORMAT_CHOICES} labels={DATE_LABEL} onChange={(dateFormat) => setRegionPrefs({ dateFormat })} />
      <Choice label="Time format" value={prefs.timeFormat} choices={TIME_FORMAT_CHOICES} labels={TIME_LABEL} onChange={(timeFormat) => setRegionPrefs({ timeFormat })} />
      <p className="text-xs" style={{ color: "var(--text-muted)" }} aria-live="polite">
        Dates and times look like this: <span data-testid="region-sample" style={{ color: "var(--text-secondary)" }}>{sample}</span>
      </p>
    </section>
  );
}
