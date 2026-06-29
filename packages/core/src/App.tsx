import { Component, useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Shell } from "./components/layout/Shell";
import { Onboarding } from "./components/layout/Onboarding";
import { useUIStore } from "./app/stores/ui";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
    },
  },
});

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: 40,
          background: '#0a0a0b',
          color: 'white',
          height: '100vh',
          fontFamily: 'Inter, system-ui, sans-serif',
        }}>
          <h2 style={{ color: '#EB5757' }}>Something went wrong</h2>
          <pre style={{ color: '#aaa', fontSize: 13, marginTop: 16, whiteSpace: 'pre-wrap' }}>
            {this.state.error.message}
          </pre>
          <pre style={{ color: '#666', fontSize: 11, marginTop: 8, whiteSpace: 'pre-wrap' }}>
            {this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function App({ skipOnboarding }: { skipOnboarding?: boolean } = {}) {
  // Show onboarding for first-time users, skip for returning users.
  // `skipOnboarding` lets a shell force-skip the (Tauri-only) wizard — the web
  // shell passes it for capability-link viewers and invited non-owners, who must
  // never see the desktop owner setup flow. Desktop passes nothing → unchanged.
  const [onboarded, setOnboarded] = useState(() => {
    try {
      return localStorage.getItem("prism:onboarded") === "true";
    } catch {
      return false;
    }
  });

  const handleOnboardingComplete = () => {
    try {
      localStorage.setItem("prism:onboarded", "true");
    } catch { /* ignore */ }
    setOnboarded(true);
  };

  // Soft vault switch: the web shell repoints the active vault and fires
  // `prism:vault-changed` instead of a full page reload (a reload would activate
  // a waiting service-worker version mid-session — "switching changed the app").
  // Drop all cached server state + close tabs (their note ids belong to the old
  // vault) so every view refetches against the newly-selected vault.
  useEffect(() => {
    const onVaultChanged = () => {
      queryClient.clear();
      useUIStore.getState().closeAllTabs();
    };
    window.addEventListener("prism:vault-changed", onVaultChanged);
    return () => window.removeEventListener("prism:vault-changed", onVaultChanged);
  }, []);

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        {(onboarded || skipOnboarding) ? <Shell /> : <Onboarding onComplete={handleOnboardingComplete} />}
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
