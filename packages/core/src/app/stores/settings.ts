import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ContentType } from "../../lib/types";

/** The SETTING. "system" follows the OS colour scheme, live (NP-AX-01). */
export type Theme = "dark" | "light" | "system";
/** What is on screen: the class on `<html>`. */
export type EffectiveTheme = "dark" | "light";

/** A recently-opened note, for the sidebar Recent widget. */
export interface RecentItem {
  id: string;
  title: string;
  type: ContentType;
}

export interface VaultConfig {
  name: string;
  url: string; // e.g. "http://localhost:1940"
  isActive: boolean;
}

interface SettingsStore {
  // Appearance
  theme: Theme;
  fontFamily: string;
  fontSize: number;
  editorFontFamily: string;
  monoFontFamily: string;

  // Vaults
  vaults: VaultConfig[];
  activeVaultUrl: string;

  // Sidebar
  sidebarLabel: string;
  /** Reopen the last open documents on launch (default). Off → start on Home. */
  startWithLastDocument: boolean;

  // Sync defaults
  defaultSyncDirection: "push" | "pull" | "bidirectional";
  autoSyncOnSave: boolean;

  // AI Model Selection
  ollamaUrl: string;
  defaultProvider: "claude" | "ollama";
  skillModels: Record<string, { provider: string; model: string }>;

  // Recently-opened notes (sidebar widget)
  recents: RecentItem[];
  // Pinned/favorited notes (sidebar widget)
  favorites: RecentItem[];

  // Actions
  setTheme: (theme: Theme) => void;
  setFontFamily: (font: string) => void;
  setFontSize: (size: number) => void;
  setEditorFontFamily: (font: string) => void;
  setMonoFontFamily: (font: string) => void;
  addVault: (name: string, url: string) => void;
  removeVault: (url: string) => void;
  setActiveVault: (url: string) => void;
  setSidebarLabel: (label: string) => void;
  setStartWithLastDocument: (enabled: boolean) => void;
  setDefaultSyncDirection: (dir: "push" | "pull" | "bidirectional") => void;
  setAutoSyncOnSave: (enabled: boolean) => void;
  setOllamaUrl: (url: string) => void;
  setDefaultProvider: (provider: "claude" | "ollama") => void;
  setSkillModel: (skill: string, provider: string, model: string) => void;
  pushRecent: (item: RecentItem) => void;
  toggleFavorite: (item: RecentItem) => void;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      // Defaults
      // New installs follow the OS; a stored choice (every existing install has one) is kept.
      theme: "system",
      fontFamily: "Inter",
      fontSize: 14,
      editorFontFamily: "Newsreader",
      monoFontFamily: "JetBrains Mono",

      vaults: [
        { name: "Default", url: "http://localhost:1940", isActive: true },
      ],
      activeVaultUrl: "http://localhost:1940",

      sidebarLabel: "Projects",
      startWithLastDocument: true,

      defaultSyncDirection: "bidirectional",
      autoSyncOnSave: false,

      ollamaUrl: "http://localhost:11434",
      defaultProvider: "claude" as const,
      skillModels: {},
      recents: [],
      favorites: [],

      // Actions
      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },
      setFontFamily: (fontFamily) => {
        set({ fontFamily });
        document.documentElement.style.setProperty("--font-sans", `'${fontFamily}', system-ui, sans-serif`);
      },
      setFontSize: (fontSize) => {
        set({ fontSize });
        document.documentElement.style.setProperty("--text-base", `${fontSize / 16}rem`);
      },
      setEditorFontFamily: (editorFontFamily) => {
        set({ editorFontFamily });
        document.documentElement.style.setProperty("--font-serif", `'${editorFontFamily}', Georgia, serif`);
      },
      setMonoFontFamily: (monoFontFamily) => {
        set({ monoFontFamily });
        document.documentElement.style.setProperty("--font-mono", `'${monoFontFamily}', 'SF Mono', monospace`);
      },
      addVault: (name, url) => {
        const { vaults } = get();
        if (vaults.some((v) => v.url === url)) return;
        set({ vaults: [...vaults, { name, url, isActive: false }] });
      },
      removeVault: (url) => {
        set((s) => ({
          vaults: s.vaults.filter((v) => v.url !== url),
        }));
      },
      setActiveVault: (url) => {
        set((s) => ({
          activeVaultUrl: url,
          vaults: s.vaults.map((v) => ({ ...v, isActive: v.url === url })),
        }));
      },
      setSidebarLabel: (label) => set({ sidebarLabel: label }),
      setStartWithLastDocument: (enabled) => set({ startWithLastDocument: enabled }),
      setDefaultSyncDirection: (dir) => set({ defaultSyncDirection: dir }),
      setAutoSyncOnSave: (enabled) => set({ autoSyncOnSave: enabled }),
      setOllamaUrl: (url) => set({ ollamaUrl: url }),
      setDefaultProvider: (provider) => set({ defaultProvider: provider }),
      setSkillModel: (skill, provider, model) =>
        set((s) => ({
          skillModels: { ...s.skillModels, [skill]: { provider, model } },
        })),
      pushRecent: (item) =>
        set((s) => ({
          recents: [item, ...s.recents.filter((r) => r.id !== item.id)].slice(0, 12),
        })),
      toggleFavorite: (item) =>
        set((s) => ({
          favorites: s.favorites.some((f) => f.id === item.id)
            ? s.favorites.filter((f) => f.id !== item.id)
            : [{ ...item }, ...s.favorites].slice(0, 30),
        })),
    }),
    {
      name: "prism-settings",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

// ── Theme ───────────────────────────────────────────────────────────────────
// The class on <html> ("light" | "dark") is the one truth every stylesheet and every
// `classList.contains("light")` reader uses. The SETTING may also be "system": then the
// class follows `prefers-color-scheme`, live. `apps/web/public/theme-boot.js` sets the same
// class before first paint (keep the two in step: storage key, colours, the rule).

/** `<meta name="theme-color">` per theme = the page background (index.html's first-paint rule). */
export const THEME_COLORS: Record<EffectiveTheme, string> = { dark: "#0a0a0b", light: "#f4f4f6" };
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The OS colour scheme. No answer (old webview, tests without matchMedia) → dark, the old default. */
export function systemTheme(): EffectiveTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  if (window.matchMedia(DARK_QUERY).matches) return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function resolveTheme(theme: Theme): EffectiveTheme {
  return theme === "light" || theme === "dark" ? theme : systemTheme();
}

const themeListeners = new Set<() => void>();
const onScreen = (): EffectiveTheme =>
  typeof document !== "undefined" && document.documentElement.classList.contains("light") ? "light" : "dark";

let classWatch: MutationObserver | null = null;
function watchThemeClass(fn: () => void): () => void {
  themeListeners.add(fn);
  // Anything may flip the class (this module, the boot script, a test): the class is the truth.
  if (!classWatch && typeof MutationObserver !== "undefined") {
    classWatch = new MutationObserver(() => themeListeners.forEach((l) => l()));
    classWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  }
  return () => {
    themeListeners.delete(fn);
    if (!themeListeners.size) { classWatch?.disconnect(); classWatch = null; }
  };
}

/** The theme on screen, for components that pass a theme to a library (code editor, canvas). */
export function useEffectiveTheme(): EffectiveTheme {
  return useSyncExternalStore(
    watchThemeClass,
    onScreen,
    () => "dark",
  );
}

/**
 * Flip light/dark from what is on screen now (⌘⇧L, the palette's "Toggle Theme"). With System
 * selected this picks the opposite of the current effective theme and so LEAVES System — an
 * explicit choice; Settings → Appearance → System goes back.
 */
export function toggleTheme(): void {
  const light = typeof document !== "undefined" ? onScreen() === "light" : useSettingsStore.getState().theme === "light";
  useSettingsStore.getState().setTheme(light ? "dark" : "light");
}

export function applyTheme(theme: Theme) {
  const effective = resolveTheme(theme);
  const root = document.documentElement;
  root.classList.toggle("light", effective === "light");
  root.classList.toggle("dark", effective === "dark");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[effective]);
}

// The OS scheme changed while the app is open: follow it, but only for the System setting.
if (typeof window !== "undefined" && window.matchMedia) {
  const query = window.matchMedia(DARK_QUERY);
  const follow = () => { if (useSettingsStore.getState().theme === "system") applyTheme("system"); };
  if (query.addEventListener) query.addEventListener("change", follow);
  else query.addListener?.(follow); // Safari < 14
}

// Initialize theme on app load
export function initializeSettings() {
  const state = useSettingsStore.getState();
  applyTheme(state.theme);

  // Apply font settings
  const root = document.documentElement;
  root.style.setProperty("--font-sans", `'${state.fontFamily}', system-ui, sans-serif`);
  root.style.setProperty("--font-serif", `'${state.editorFontFamily}', Georgia, serif`);
  root.style.setProperty("--font-mono", `'${state.monoFontFamily}', 'SF Mono', monospace`);
  if (state.fontSize !== 14) {
    root.style.setProperty("--text-base", `${state.fontSize / 16}rem`);
  }
}
