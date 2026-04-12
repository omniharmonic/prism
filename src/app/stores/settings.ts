import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type Theme = "dark" | "light";

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

  // Sync defaults
  defaultSyncDirection: "push" | "pull" | "bidirectional";
  autoSyncOnSave: boolean;

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
  setDefaultSyncDirection: (dir: "push" | "pull" | "bidirectional") => void;
  setAutoSyncOnSave: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      // Defaults
      theme: "dark",
      fontFamily: "Inter",
      fontSize: 14,
      editorFontFamily: "Newsreader",
      monoFontFamily: "JetBrains Mono",

      vaults: [
        { name: "Default", url: "http://localhost:1940", isActive: true },
      ],
      activeVaultUrl: "http://localhost:1940",

      sidebarLabel: "Projects",

      defaultSyncDirection: "bidirectional",
      autoSyncOnSave: false,

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
      setDefaultSyncDirection: (dir) => set({ defaultSyncDirection: dir }),
      setAutoSyncOnSave: (enabled) => set({ autoSyncOnSave: enabled }),
    }),
    {
      name: "prism-settings",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

// Apply theme — just toggle the class. CSS handles all the values.
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "light") {
    root.classList.add("light");
    root.classList.remove("dark");
  } else {
    root.classList.add("dark");
    root.classList.remove("light");
  }
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
