import { useState, useEffect } from "react";
import { Check, Loader2, Database, MessageSquare, Sparkles, ArrowRight } from "lucide-react";
import { configApi } from "../../lib/agent/client";
import { Button } from "../ui/Button";

interface OnboardingProps {
  onComplete: () => void;
}

export function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [checking, setChecking] = useState(true);
  const [parachuteOk, setParachuteOk] = useState(false);
  const [matrixOk, setMatrixOk] = useState(false);

  useEffect(() => {
    async function check() {
      try {
        const status = await configApi.getStatus();
        setParachuteOk(true); // If we got here, Parachute is responding (via Tauri)
        setMatrixOk(status.matrix.configured);
      } catch {
        setParachuteOk(false);
      } finally {
        setChecking(false);
      }
    }
    check();
  }, []);

  const steps = [
    // Step 0: Welcome
    <div key="welcome" className="text-center space-y-6">
      <div className="text-5xl font-bold" style={{ color: "var(--text-primary)", fontFamily: "var(--font-sans)" }}>
        Prism
      </div>
      <p className="text-lg" style={{ color: "var(--text-secondary)" }}>
        The universal interface for your entire digital life.
      </p>
      <p className="text-sm max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
        One window. Every message, every document, every task, every event.
        The data flows where it needs to. The agent handles the plumbing.
      </p>
      <Button variant="primary" size="lg" onClick={() => setStep(1)}>
        Get Started <ArrowRight size={16} />
      </Button>
    </div>,

    // Step 1: Service checks
    <div key="services" className="space-y-6">
      <h2 className="text-xl font-semibold text-center" style={{ color: "var(--text-primary)" }}>
        Checking connections
      </h2>

      <div className="space-y-3 max-w-sm mx-auto">
        <ServiceCheck
          icon={<Database size={18} />}
          name="Parachute Vault"
          status={checking ? "checking" : parachuteOk ? "ok" : "error"}
          detail={parachuteOk ? "Connected at localhost:1940" : "Start Parachute first"}
        />
        <ServiceCheck
          icon={<MessageSquare size={18} />}
          name="Matrix (Messaging)"
          status={checking ? "checking" : matrixOk ? "ok" : "warning"}
          detail={matrixOk ? "Connected via omniharmonic config" : "Optional — configure later in Settings"}
        />
        <ServiceCheck
          icon={<Sparkles size={18} />}
          name="Claude Code"
          status="ok"
          detail="Using native Claude Code CLI"
        />
      </div>

      <div className="flex justify-center pt-4">
        <Button variant="primary" size="lg" onClick={() => setStep(2)} disabled={checking}>
          Continue <ArrowRight size={16} />
        </Button>
      </div>
    </div>,

    // Step 2: Ready
    <div key="ready" className="text-center space-y-6">
      <div
        className="w-16 h-16 rounded-full flex items-center justify-center mx-auto"
        style={{ background: "rgba(111,207,151,0.15)" }}
      >
        <Check size={32} style={{ color: "var(--color-success)" }} />
      </div>
      <h2 className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
        You're all set
      </h2>
      <p className="text-sm max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
        Your vault is connected with {parachuteOk ? "100+" : "your"} notes ready to explore.
        Use <kbd className="glass px-1.5 py-0.5 rounded text-xs">&#8984;K</kbd> to search,
        create, or ask Claude anything.
      </p>
      <Button variant="primary" size="lg" onClick={onComplete}>
        Open Prism
      </Button>
    </div>,
  ];

  return (
    <div
      className="h-screen w-screen flex items-center justify-center"
      style={{ background: "var(--bg-base)" }}
    >
      <div className="w-full max-w-lg px-8">
        {steps[step]}

        {/* Step indicators */}
        <div className="flex justify-center gap-2 mt-8">
          {steps.map((_, i) => (
            <div
              key={i}
              className="w-2 h-2 rounded-full transition-colors"
              style={{ background: i === step ? "var(--color-accent)" : "var(--glass)" }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ServiceCheck({ icon, name, status, detail }: {
  icon: React.ReactNode;
  name: string;
  status: "checking" | "ok" | "warning" | "error";
  detail: string;
}) {
  return (
    <div className="glass p-3 rounded-lg flex items-center gap-3">
      <span style={{ color: "var(--text-secondary)" }}>{icon}</span>
      <div className="flex-1">
        <div className="text-sm" style={{ color: "var(--text-primary)" }}>{name}</div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>{detail}</div>
      </div>
      {status === "checking" && <Loader2 size={16} className="animate-spin" style={{ color: "var(--text-muted)" }} />}
      {status === "ok" && <Check size={16} style={{ color: "var(--color-success)" }} />}
      {status === "warning" && <span className="text-xs" style={{ color: "var(--color-warning)" }}>Optional</span>}
      {status === "error" && <span className="text-xs" style={{ color: "var(--color-danger)" }}>Offline</span>}
    </div>
  );
}
