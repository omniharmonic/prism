// Native build only: aliased over `virtual:pwa-register/react` (vite.config.ts).
// There is no service worker in a native shell, so there is never an update to
// prompt for; UpdatePrompt still imports the hook, and this keeps it inert.
export function useRegisterSW() {
  return {
    needRefresh: [false, () => {}] as [boolean, (v: boolean) => void],
    offlineReady: [false, () => {}] as [boolean, (v: boolean) => void],
    updateServiceWorker: async (_reload?: boolean) => {},
  };
}
