import { useState, useCallback, useRef, useEffect } from "react";
import { Check, Loader2, Database, MessageSquare, Sparkles, ArrowRight, ArrowLeft, Mail, Cloud, AlertCircle, Layers } from "lucide-react";
import { agentApi, configApi } from "../../lib/agent/client";
import { Button } from "../ui/Button";
import { useSettingsStore } from "../../app/stores/settings";

interface OnboardingProps {
  onComplete: () => void;
}

type StepStatus = "pending" | "testing" | "success" | "error" | "skipped";

export function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const { activeVaultUrl } = useSettingsStore();

  // Step states
  const [parachuteUrl, setParachuteUrl] = useState(activeVaultUrl || "http://localhost:1940");
  const [parachuteStatus, setParachuteStatus] = useState<StepStatus>("pending");
  const [parachuteError, setParachuteError] = useState("");

  const [matrixHomeserver, setMatrixHomeserver] = useState("http://localhost:8008");
  const [matrixToken, setMatrixToken] = useState("");
  const [matrixStatus, setMatrixStatus] = useState<StepStatus>("pending");
  const [matrixError, setMatrixError] = useState("");
  const [matrixRooms, setMatrixRooms] = useState(0);

  const [schemaMessages, setSchemaMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [schemaInput, setSchemaInput] = useState("");
  const [schemaLoading, setSchemaLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const [googleStatus, setGoogleStatus] = useState<StepStatus>("pending");
  const [notionKey, setNotionKey] = useState("");
  const [notionStatus, setNotionStatus] = useState<StepStatus>("pending");
  const [claudeStatus, setClaudeStatus] = useState<StepStatus>("pending");

  const testParachute = useCallback(async () => {
    setParachuteStatus("testing");
    setParachuteError("");
    try {
      await configApi.testParachute(parachuteUrl);
      setParachuteStatus("success");
    } catch (e) {
      setParachuteStatus("error");
      setParachuteError(String(e));
    }
  }, [parachuteUrl]);

  const testMatrix = useCallback(async () => {
    setMatrixStatus("testing");
    setMatrixError("");
    try {
      const result = await configApi.testMatrix(matrixHomeserver, matrixToken);
      setMatrixStatus("success");
      setMatrixRooms(result.rooms);
    } catch (e) {
      setMatrixStatus("error");
      setMatrixError(String(e));
    }
  }, [matrixHomeserver, matrixToken]);

  const checkGoogle = useCallback(async () => {
    setGoogleStatus("testing");
    try {
      const result = await configApi.checkGoogleCli();
      setGoogleStatus(result.installed ? "success" : "error");
    } catch {
      setGoogleStatus("error");
    }
  }, []);

  const testNotion = useCallback(async () => {
    if (!notionKey.trim()) { setNotionStatus("skipped"); return; }
    setNotionStatus("testing");
    try {
      await configApi.testNotion(notionKey);
      setNotionStatus("success");
    } catch {
      setNotionStatus("error");
    }
  }, [notionKey]);

  const checkClaude = useCallback(async () => {
    setClaudeStatus("testing");
    try {
      const result = await configApi.checkClaudeCli();
      setClaudeStatus(result.installed ? "success" : "error");
    } catch {
      setClaudeStatus("error");
    }
  }, []);

  const sendSchemaMessage = useCallback(async (message: string) => {
    if (!message.trim() || schemaLoading) return;

    setSchemaMessages(prev => [...prev, { role: "user", content: message }]);
    setSchemaInput("");
    setSchemaLoading(true);

    try {
      const systemContext = `You are helping set up a new Parachute vault for Prism. The user will describe their use case. Based on that, create appropriate tag schemas using the Parachute MCP tools (mcp__parachute-vault__update-tag). Create 6-12 tags with field schemas appropriate for their use case. Be conversational and friendly. After creating tags, confirm what you've set up.`;

      const result = await agentApi.chat(
        `${systemContext}\n\nUser: ${message}`
      );

      setSchemaMessages(prev => [...prev, { role: "assistant", content: result.message }]);
    } catch (e) {
      setSchemaMessages(prev => [...prev, { role: "assistant", content: `Setup error: ${e}. You can skip this step and configure tags later.` }]);
    }

    setSchemaLoading(false);
  }, [schemaLoading]);

  const useTemplate = useCallback((template: string) => {
    const prompts: Record<string, string> = {
      "Personal KM": "I want to use Prism as a personal knowledge management system. I track people, topics, sources, insights, and reference materials across my work and personal life.",
      "Project Tracking": "I need Prism for project management. I track projects, tasks, milestones, decisions, risks, and stakeholders.",
      "Research": "I'm a researcher. I need to track papers, experiments, datasets, findings, methodologies, and citations.",
      "CRM": "I want to use Prism as a CRM. I track people, companies, deals, interactions, and pipeline stages.",
      "Writing": "I'm a writer. I need to organize drafts, chapters, characters, settings, research notes, and outlines.",
      "Meeting Notes": "I use Prism primarily for meeting notes. I need to track meetings, action items, decisions, attendees, and agendas.",
    };
    sendSchemaMessage(prompts[template] || template);
  }, [sendSchemaMessage]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [schemaMessages, schemaLoading]);

  const steps = [
    // Step 0: Welcome
    <div key="welcome" className="text-center space-y-6 max-w-md mx-auto">
      <div className="text-4xl font-bold" style={{ color: "var(--text-primary)" }}>Prism</div>
      <p className="text-lg" style={{ color: "var(--text-secondary)" }}>
        The universal interface for your entire digital life.
      </p>
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Let's connect your services so everything flows through one window.
      </p>
      <Button variant="primary" size="lg" onClick={() => setStep(1)}>
        Get Started <ArrowRight size={16} />
      </Button>
    </div>,

    // Step 1: Parachute
    <div key="parachute" className="space-y-4 max-w-md mx-auto">
      <StepHeader icon={<Database size={20} />} title="Connect Parachute Vault" description="Your knowledge graph and data layer." />
      <div className="space-y-2">
        <label className="text-xs" style={{ color: "var(--text-muted)" }}>Vault URL</label>
        <input value={parachuteUrl} onChange={(e) => setParachuteUrl(e.target.value)}
          className="w-full h-8 rounded-lg px-3 text-sm outline-none"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)", fontFamily: "var(--font-mono)" }} />
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={testParachute} loading={parachuteStatus === "testing"}>
          Test Connection
        </Button>
        <StatusIndicator status={parachuteStatus} />
      </div>
      {parachuteError && <div className="text-xs" style={{ color: "var(--color-danger)" }}>{parachuteError}</div>}
      <NavButtons onBack={() => setStep(0)} onNext={() => setStep(2)} canProceed skipLabel={parachuteStatus !== "success" ? "Skip" : undefined} />
    </div>,

    // Step 2: Knowledge Schema
    <div key="schema" className="space-y-4 max-w-md mx-auto">
      <StepHeader icon={<Layers size={20} />} title="Knowledge Schema" description="Let's set up your vault's knowledge schema. Tell Claude about what you'll use Prism for, and it'll create the right tags." />

      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Tell Claude about your use case and it will create the right tag schemas for your vault.
      </p>

      {/* Template buttons */}
      <div className="flex flex-wrap gap-2">
        {["Personal KM", "Project Tracking", "Research", "CRM", "Writing", "Meeting Notes"].map(t => (
          <button
            key={t}
            onClick={() => useTemplate(t)}
            className="px-3 py-1.5 text-xs rounded-lg transition-colors"
            style={{
              background: "var(--glass)",
              border: "1px solid var(--glass-border)",
              color: "var(--text-muted)",
            }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--glass-hover, rgba(255,255,255,0.1))"; e.currentTarget.style.color = "var(--text-primary)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "var(--glass)"; e.currentTarget.style.color = "var(--text-muted)"; }}
            disabled={schemaLoading}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Chat messages */}
      <div className="h-48 overflow-y-auto space-y-3 p-3 rounded-lg" style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--glass-border)" }}>
        {schemaMessages.length === 0 && (
          <p className="text-xs italic" style={{ color: "var(--text-muted)" }}>Choose a template above or describe your use case...</p>
        )}
        {schemaMessages.map((msg, i) => (
          <div key={i} className="text-sm" style={{ color: msg.role === "user" ? "var(--text-secondary)" : "var(--color-accent)" }}>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>{msg.role === "user" ? "You" : "Claude"}:</span>
            <p className="mt-0.5 whitespace-pre-wrap">{msg.content}</p>
          </div>
        ))}
        {schemaLoading && (
          <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
            <Loader2 className="w-3 h-3 animate-spin" /> Claude is setting up your vault...
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={schemaInput}
          onChange={e => setSchemaInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && sendSchemaMessage(schemaInput)}
          placeholder="Describe your use case..."
          className="flex-1 px-3 py-2 text-sm rounded-lg outline-none"
          style={{
            background: "var(--glass)",
            border: "1px solid var(--glass-border)",
            color: "var(--text-primary)",
          }}
          disabled={schemaLoading}
        />
        <Button
          variant="secondary"
          onClick={() => sendSchemaMessage(schemaInput)}
          disabled={schemaLoading || !schemaInput.trim()}
        >
          Send
        </Button>
      </div>

      <NavButtons onBack={() => setStep(1)} onNext={() => setStep(3)} canProceed skipLabel="Skip" />
    </div>,

    // Step 3: Matrix
    <div key="matrix" className="space-y-4 max-w-md mx-auto">
      <StepHeader icon={<MessageSquare size={20} />} title="Matrix Messaging" description="Unified messaging across platforms. Optional." />
      <div className="space-y-2">
        <label className="text-xs" style={{ color: "var(--text-muted)" }}>Homeserver URL</label>
        <input value={matrixHomeserver} onChange={(e) => setMatrixHomeserver(e.target.value)}
          className="w-full h-8 rounded-lg px-3 text-sm outline-none"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)", fontFamily: "var(--font-mono)" }} />
        <label className="text-xs" style={{ color: "var(--text-muted)" }}>Access Token</label>
        <input value={matrixToken} onChange={(e) => setMatrixToken(e.target.value)} type="password"
          placeholder="syt_..."
          className="w-full h-8 rounded-lg px-3 text-sm outline-none"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)", fontFamily: "var(--font-mono)" }} />
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={testMatrix} loading={matrixStatus === "testing"}>Test</Button>
        <StatusIndicator status={matrixStatus} detail={matrixStatus === "success" ? `${matrixRooms} rooms` : matrixError} />
      </div>
      <NavButtons onBack={() => setStep(2)} onNext={() => setStep(4)} canProceed skipLabel="Skip" />
    </div>,

    // Step 4: Google + Notion + Claude
    <div key="services" className="space-y-4 max-w-md mx-auto">
      <StepHeader icon={<Sparkles size={20} />} title="Additional Services" description="These enhance Prism's capabilities." />

      {/* Google */}
      <div className="glass p-3 rounded-lg space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Mail size={14} style={{ color: "var(--text-secondary)" }} />
            <span className="text-sm" style={{ color: "var(--text-primary)" }}>Google (via gog CLI)</span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={checkGoogle} loading={googleStatus === "testing"}>Check</Button>
            <StatusIndicator status={googleStatus} />
          </div>
        </div>
        {googleStatus === "error" && (
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>
            Install: <code style={{ color: "var(--color-accent)" }}>brew install gog</code> then <code>gog auth login</code>
          </div>
        )}
      </div>

      {/* Notion */}
      <div className="glass p-3 rounded-lg space-y-2">
        <div className="flex items-center gap-2">
          <Cloud size={14} style={{ color: "var(--text-secondary)" }} />
          <span className="text-sm" style={{ color: "var(--text-primary)" }}>Notion</span>
        </div>
        <input value={notionKey} onChange={(e) => setNotionKey(e.target.value)} type="password"
          placeholder="Notion API key (ntn_...)"
          className="w-full h-7 rounded px-2 text-xs outline-none"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)", fontFamily: "var(--font-mono)" }} />
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={testNotion} loading={notionStatus === "testing"}>Test</Button>
          <StatusIndicator status={notionStatus} />
        </div>
      </div>

      {/* Claude */}
      <div className="glass p-3 rounded-lg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles size={14} style={{ color: "var(--text-secondary)" }} />
            <span className="text-sm" style={{ color: "var(--text-primary)" }}>Claude Code CLI</span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={checkClaude} loading={claudeStatus === "testing"}>Check</Button>
            <StatusIndicator status={claudeStatus} />
          </div>
        </div>
      </div>

      <NavButtons onBack={() => setStep(3)} onNext={() => setStep(5)} canProceed skipLabel="Skip All" />
    </div>,

    // Step 5: Ready
    <div key="ready" className="text-center space-y-6 max-w-md mx-auto">
      <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto" style={{ background: "rgba(111,207,151,0.15)" }}>
        <Check size={32} style={{ color: "var(--color-success)" }} />
      </div>
      <h2 className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>You're all set</h2>
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Use <kbd>⌘K</kbd> to search, create, or ask Claude. Access Settings from the gear icon anytime.
      </p>
      <Button variant="primary" size="lg" onClick={onComplete}>Open Prism</Button>
    </div>,
  ];

  return (
    <div className="h-screen w-screen flex items-center justify-center" style={{ background: "var(--bg-base)" }}>
      <div className="w-full max-w-lg px-8">
        {steps[step]}
        <div className="flex justify-center gap-2 mt-8">
          {steps.map((_, i) => (
            <div key={i} className="w-2 h-2 rounded-full" style={{ background: i === step ? "var(--color-accent)" : "var(--glass)" }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function StepHeader({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="flex items-start gap-3 mb-4">
      <span className="mt-1" style={{ color: "var(--color-accent)" }}>{icon}</span>
      <div>
        <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>{title}</h2>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>{description}</p>
      </div>
    </div>
  );
}

function StatusIndicator({ status, detail }: { status: StepStatus; detail?: string }) {
  if (status === "pending" || status === "skipped") return null;
  if (status === "testing") return <Loader2 size={14} className="animate-spin" style={{ color: "var(--text-muted)" }} />;
  if (status === "success") return (
    <span className="flex items-center gap-1 text-xs" style={{ color: "var(--color-success)" }}>
      <Check size={12} /> {detail || "Connected"}
    </span>
  );
  return (
    <span className="flex items-center gap-1 text-xs" style={{ color: "var(--color-danger)" }}>
      <AlertCircle size={12} /> {detail || "Failed"}
    </span>
  );
}

function NavButtons({ onBack, onNext, canProceed = true, skipLabel }: {
  onBack?: () => void; onNext: () => void; canProceed?: boolean; skipLabel?: string;
}) {
  return (
    <div className="flex justify-between pt-4">
      {onBack ? (
        <Button variant="ghost" onClick={onBack}><ArrowLeft size={14} /> Back</Button>
      ) : <div />}
      <div className="flex gap-2">
        {skipLabel && !canProceed && (
          <Button variant="ghost" onClick={onNext}>{skipLabel}</Button>
        )}
        <Button variant="primary" onClick={onNext} disabled={!canProceed}>
          Continue <ArrowRight size={14} />
        </Button>
      </div>
    </div>
  );
}
