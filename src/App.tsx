import { Component, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Shell } from "./components/layout/Shell";
import { Onboarding } from "./components/layout/Onboarding";

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

function App() {
  // Show onboarding for first-time users, skip for returning users
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

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        {onboarded ? <Shell /> : <Onboarding onComplete={handleOnboardingComplete} />}
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
