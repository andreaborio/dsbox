import { AnimatePresence, motion } from "framer-motion";
import {
  Bot,
  ChevronRight,
  Gauge,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Power,
  Settings,
  X
} from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";
import { DsboxOrb, type DsboxOrbState } from "./components/DsboxOrb";
import { useDsbox } from "./hooks/useDsbox";
import { formatModelName } from "./lib/format";
import type { ViewId } from "./types";

const ChatView = lazy(() => import("./views/ChatView").then((module) => ({ default: module.ChatView })));
const RuntimeView = lazy(() => import("./views/RuntimeView").then((module) => ({ default: module.RuntimeView })));
const AgentsView = lazy(() => import("./views/AgentsView").then((module) => ({ default: module.AgentsView })));
const MonitorView = lazy(() => import("./views/MonitorView").then((module) => ({ default: module.MonitorView })));
const SettingsView = lazy(() => import("./views/SettingsView").then((module) => ({ default: module.SettingsView })));

const navigation: Array<{ id: ViewId; label: string; icon: typeof MessageSquareText }> = [
  { id: "chat", label: "Chat", icon: MessageSquareText },
  { id: "runtime", label: "Server", icon: Power },
  { id: "agents", label: "Agenti", icon: Bot },
  { id: "monitor", label: "Attività", icon: Gauge }
];

const titles: Record<ViewId, { title: string; subtitle: string }> = {
  chat: { title: "Chat", subtitle: "Sessione locale privata" },
  runtime: { title: "Server", subtitle: "Accensione e modello" },
  agents: { title: "Agenti", subtitle: "Collega il tuo coding agent" },
  monitor: { title: "Attività", subtitle: "Risorse e stato" },
  settings: { title: "Impostazioni", subtitle: "Modello, prestazioni e privacy" }
};

export default function App() {
  const controller = useDsbox();
  const [view, setView] = useState<ViewId>("chat");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const snapshot = controller.snapshot;

  const content = useMemo(() => {
    if (!snapshot) return null;
    const shared = { snapshot, controller, onNavigate: setView };
    switch (view) {
      case "chat": return <ChatView {...shared} />;
      case "runtime": return <RuntimeView {...shared} />;
      case "agents": return <AgentsView {...shared} />;
      case "monitor": return <MonitorView {...shared} />;
      case "settings": return <SettingsView {...shared} />;
    }
  }, [controller, snapshot, view]);

  if (!snapshot) {
    return (
      <div className="boot-screen">
        <DsboxOrb state="preparing" size="md" />
        <div className="boot-screen__wordmark">DSBox</div>
        <div className="boot-screen__line"><span /></div>
        <p>Apro DSBox…</p>
        {controller.error && <div className="boot-screen__error">{controller.error}</div>}
      </div>
    );
  }

  const activeTitle = titles[view];
  const latest = snapshot.metrics.at(-1);
  const orbState: DsboxOrbState = snapshot.runtime.phase === "error"
    ? "error"
    : ["preparing", "installing", "updating", "building", "downloading", "starting", "stopping"].includes(snapshot.runtime.phase)
      ? "preparing"
      : snapshot.runtime.phase === "running"
        ? snapshot.activity.stage === "idle" ? "ready" : snapshot.activity.stage
        : "off";

  return (
    <div className={`app-shell ${sidebarCollapsed ? "app-shell--collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar__brand">
          <DsboxOrb state={orbState} size="sm" decorative />
          <AnimatePresence initial={false}>
            {!sidebarCollapsed && (
              <motion.div
                className="sidebar__wordmark"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -6 }}
              >
                <strong>DSBox</strong>
                <span>AI locale</span>
              </motion.div>
            )}
          </AnimatePresence>
          <button
            className="sidebar__collapse icon-button"
            onClick={() => setSidebarCollapsed((current) => !current)}
            aria-label={sidebarCollapsed ? "Espandi barra laterale" : "Comprimi barra laterale"}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>

        <nav className="sidebar__nav" aria-label="Navigazione principale">
          <div className="nav-label">Workspace</div>
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={`nav-item ${view === item.id ? "nav-item--active" : ""}`}
                onClick={() => setView(item.id)}
                title={sidebarCollapsed ? item.label : undefined}
                aria-label={item.label}
                aria-current={view === item.id ? "page" : undefined}
              >
                <Icon size={18} strokeWidth={1.8} />
                <span>{item.label}</span>
                {item.id === "runtime" && snapshot.runtime.phase === "error" && <i className="nav-alert" />}
                {item.id === "monitor" && snapshot.runtime.phase === "running" && (
                  <small>{latest?.tokensPerSecond ? `${latest.tokensPerSecond.toFixed(1)} t/s` : "live"}</small>
                )}
              </button>
            );
          })}
        </nav>

        <div className="sidebar__spacer" />
        <button
          className={`nav-item nav-item--settings ${view === "settings" ? "nav-item--active" : ""}`}
          onClick={() => setView("settings")}
          title={sidebarCollapsed ? "Impostazioni" : undefined}
          aria-label="Impostazioni"
          aria-current={view === "settings" ? "page" : undefined}
        >
          <Settings size={18} strokeWidth={1.8} />
          <span>Impostazioni</span>
        </button>

        <button className="sidebar__runtime" onClick={() => setView("runtime")} aria-label={`Server: ${snapshot.runtime.phase === "running" ? "acceso" : "spento"}`}>
          <div className="sidebar__runtime-head">
            <span className={`status-orb status-orb--${snapshot.runtime.phase}`} />
            <div>
              <strong>{formatModelName(snapshot.config.model.id)}</strong>
              <span>{snapshot.runtime.phase === "running" ? "Pronto sul tuo Mac" : snapshot.runtime.currentTask ?? "DSBox spento"}</span>
            </div>
          </div>
          <ChevronRight size={15} />
        </button>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="topbar__title">
            <h1>{activeTitle.title}</h1>
            <span>{activeTitle.subtitle}</span>
          </div>
          <div className="topbar__actions">
            <button
              className={`topbar__power ${snapshot.runtime.phase === "running" ? "topbar__power--on" : ""}`}
              onClick={() => {
                const busy = ["preparing", "installing", "updating", "building", "downloading", "starting", "stopping"].includes(snapshot.runtime.phase);
                if (busy) {
                  setView("runtime");
                  return;
                }
                void controller.action(snapshot.runtime.phase === "running" ? "Spegnimento DSBox" : "Accensione DSBox", "/api/runtime/power").catch(() => undefined);
              }}
              aria-label={snapshot.runtime.phase === "running" ? "Spegni DSBox" : "Accendi DSBox"}
            >
              <span className="topbar__power-dot" />
              <span>{snapshot.runtime.phase === "running" ? "Acceso" : ["preparing", "installing", "updating", "building", "downloading", "starting", "stopping"].includes(snapshot.runtime.phase) ? "In corso" : "Accendi"}</span>
              <Power size={15} />
            </button>
          </div>
        </header>

        <div className="view-stage">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={view}
              className={`view view--${view}`}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.14, ease: [0.2, 0.8, 0.2, 1] }}
            >
              <Suspense fallback={<div className="view-loading"><DsboxOrb state="preparing" size="sm" decorative /><span>Caricamento vista…</span></div>}>
                {content}
              </Suspense>
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      <AnimatePresence>
        {controller.error && (
          <motion.div
            className={`toast toast--error ${view === "settings" ? "toast--above-savebar" : ""}`}
            role="alert"
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8 }}
          >
            <span className="toast__icon">!</span>
            <div><strong>Operazione non riuscita</strong><p>{controller.error}</p></div>
            <button onClick={controller.clearError} aria-label="Chiudi"><X size={16} /></button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className={`connection-indicator ${controller.connected ? "connection-indicator--on" : ""}`} title={controller.connected ? "Aggiornamenti live connessi" : "Riconnessione…"}>
        <span />
      </div>
    </div>
  );
}
