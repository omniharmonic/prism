import React, { useState } from "react";

/**
 * Design Lab — a dev-only visual harness for the "Blue Sky" design system.
 *
 * Renders the token layer, glass surfaces, primitives, and representative
 * compositions (sidebar, tab bar, document) with NO backend or auth, so the
 * design language can be iterated and screenshotted in isolation. Mounted only
 * in dev at /design-lab (see main.tsx). Doubles as living styleguide docs.
 */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: "var(--space-12)" }}>
      <div className="text-label" style={{ marginBottom: "var(--space-4)" }}>{title}</div>
      {children}
    </section>
  );
}

function Swatch({ name, varName }: { name: string; varName: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          height: 56,
          borderRadius: "var(--radius-md)",
          background: `var(${varName})`,
          border: "1px solid var(--glass-border)",
        }}
      />
      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{name}</div>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{varName}</div>
    </div>
  );
}

const ROW = (label: string, selected = false) => (
  <div
    key={label}
    className="interactive"
    data-selected={selected || undefined}
    style={{
      display: "flex",
      alignItems: "center",
      gap: "var(--space-3)",
      padding: "7px var(--space-3)",
      fontSize: "var(--text-base)",
      color: selected ? "var(--text-primary)" : "var(--text-secondary)",
    }}
  >
    <span style={{ width: 15, height: 15, borderRadius: 4, background: "var(--surface-active)", flexShrink: 0 }} />
    {label}
  </div>
);

export function DesignLab() {
  const [theme, setTheme] = useState<"dark" | "light">(
    document.documentElement.classList.contains("light") ? "light" : "dark",
  );

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("light", next === "light");
    document.documentElement.classList.toggle("dark", next === "dark");
    setTheme(next);
  }

  const btn = (variant: "primary" | "secondary" | "ghost", label: string) => {
    const base: React.CSSProperties = {
      height: 32,
      padding: "0 14px",
      borderRadius: "var(--radius-sm)",
      fontSize: "var(--text-base)",
      fontWeight: 500,
      border: "1px solid transparent",
      cursor: "pointer",
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
    };
    if (variant === "primary")
      return <button style={{ ...base, background: "var(--color-accent)", color: "#fff" }}>{label}</button>;
    if (variant === "secondary")
      return <button className="glass-interactive" style={{ ...base, color: "var(--text-primary)" }}>{label}</button>;
    return (
      <button className="interactive" style={{ ...base, background: "transparent", color: "var(--text-secondary)" }}>{label}</button>
    );
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-base)", color: "var(--text-primary)" }}>
      {/* Header */}
      <div
        className="glass"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "var(--space-4) var(--space-8)",
          borderRadius: 0,
          borderLeft: "none",
          borderRight: "none",
          borderTop: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-3)" }}>
          <span style={{ fontSize: "var(--text-xl)", fontWeight: 700, letterSpacing: "-0.02em" }}>Prism</span>
          <span style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>Blue Sky · Design Lab</span>
        </div>
        <button className="glass-interactive" onClick={toggle} style={{ height: 30, padding: "0 12px", borderRadius: "var(--radius-sm)", fontSize: "var(--text-sm)", color: "var(--text-primary)" }}>
          {theme === "dark" ? "◐ Dark" : "◑ Light"}
        </button>
      </div>

      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "var(--space-10) var(--space-8)" }}>
        <Section title="Surface palette">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: "var(--space-4)" }}>
            <Swatch name="Base" varName="--bg-base" />
            <Swatch name="Surface" varName="--bg-surface" />
            <Swatch name="Elevated" varName="--bg-elevated" />
            <Swatch name="Accent" varName="--color-accent" />
            <Swatch name="Accent dim" varName="--color-accent-dim" />
            <Swatch name="Success" varName="--color-success" />
            <Swatch name="Warning" varName="--color-warning" />
            <Swatch name="Danger" varName="--color-danger" />
          </div>
        </Section>

        <Section title="Type scale">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            {([
              ["3xl", "The quick brown fox"],
              ["2xl", "The quick brown fox"],
              ["xl", "The quick brown fox"],
              ["lg", "The quick brown fox jumps over the lazy dog"],
              ["base", "The quick brown fox jumps over the lazy dog"],
              ["sm", "The quick brown fox jumps over the lazy dog"],
              ["xs", "THE QUICK BROWN FOX"],
            ] as const).map(([size, text]) => (
              <div key={size} style={{ display: "flex", alignItems: "baseline", gap: "var(--space-4)" }}>
                <span className="text-label" style={{ width: 40 }}>{size}</span>
                <span style={{ fontSize: `var(--text-${size})`, letterSpacing: "-0.01em" }}>{text}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Buttons">
          <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center", flexWrap: "wrap" }}>
            {btn("primary", "Primary")}
            {btn("secondary", "Secondary")}
            {btn("ghost", "Ghost")}
          </div>
        </Section>

        <Section title="Glass surfaces">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "var(--space-4)" }}>
            <div className="glass" style={{ padding: "var(--space-5)" }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>.glass</div>
              <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>Base panel — quiet, hairline border.</div>
            </div>
            <div className="glass-interactive" style={{ padding: "var(--space-5)" }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>.glass-interactive</div>
              <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>Hover & press me.</div>
            </div>
            <div className="glass-elevated" style={{ padding: "var(--space-5)" }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>.glass-elevated</div>
              <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>Floating — real blur + shadow.</div>
            </div>
            <div className="glass-inset" style={{ padding: "var(--space-5)" }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>.glass-inset</div>
              <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>Inner well / input.</div>
            </div>
          </div>
        </Section>

        <Section title="Inputs & badges">
          <div style={{ display: "flex", gap: "var(--space-4)", flexWrap: "wrap", alignItems: "center" }}>
            <input
              placeholder="Search…"
              className="glass-inset"
              style={{ height: 34, padding: "0 12px", width: 240, color: "var(--text-primary)", background: "var(--glass-inset, transparent)", outline: "none" }}
            />
            {(["accent", "success", "warning", "danger"] as const).map((c) => (
              <span
                key={c}
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: 500,
                  padding: "3px 9px",
                  borderRadius: "var(--radius-full)",
                  color: `var(--color-${c})`,
                  background: `color-mix(in srgb, var(--color-${c}) 14%, transparent)`,
                }}
              >
                {c}
              </span>
            ))}
            <kbd>⌘K</kbd>
          </div>
        </Section>

        {/* Composition: sidebar + content, like the real shell */}
        <Section title="Composition — shell">
          <div
            className="glass"
            style={{
              display: "grid",
              gridTemplateColumns: "240px 1fr",
              height: 380,
              overflow: "hidden",
              padding: 0,
            }}
          >
            {/* sidebar */}
            <div style={{ borderRight: "1px solid var(--glass-border)", padding: "var(--space-3)", display: "flex", flexDirection: "column", gap: 2 }}>
              <input
                placeholder="Search"
                className="glass-inset"
                style={{ height: 30, padding: "0 10px", marginBottom: "var(--space-3)", fontSize: "var(--text-sm)", color: "var(--text-primary)", background: "transparent", outline: "none" }}
              />
              <div className="text-label" style={{ padding: "0 var(--space-3)", marginBottom: 4 }}>Workspace</div>
              {ROW("Inbox")}
              {ROW("Today")}
              {ROW("Projects", true)}
              {ROW("Notes")}
              {ROW("Calendar")}
              <div className="text-label" style={{ padding: "0 var(--space-3)", margin: "var(--space-4) 0 4px" }}>Recent</div>
              {ROW("Q2 Roadmap")}
              {ROW("Design system")}
              {ROW("Weekly sync")}
            </div>
            {/* content */}
            <div style={{ padding: "var(--space-8)", overflow: "auto" }}>
              <div className="prose-editor" style={{ margin: 0 }}>
                <h1>Blue Sky</h1>
                <p style={{ color: "var(--text-secondary)" }}>
                  A calm, airy, content-first surface in the spirit of Notion and Anytype. Restrained translucency,
                  generous whitespace, refined typography, and a single sky-blue accent.
                </p>
                <h2>Principles</h2>
                <p>Typography first. Quiet by default. Hover-reveal affordances. Fast, subtle motion.</p>
                <blockquote>The interface should disappear, leaving only your thinking.</blockquote>
              </div>
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
