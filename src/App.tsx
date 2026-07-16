import { AnimatePresence, motion } from "framer-motion";
import {
  Boxes,
  ChartNoAxesCombined,
  ChevronRight,
  CirclePower,
  CircleStop,
  HardDrive,
  MessageCircleMore,
  PanelLeftClose,
  PanelLeftOpen,
  SlidersHorizontal,
  Workflow,
  X
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { ChatSidebarThreads } from "./components/ChatSidebarThreads";
import { ModelIdentityIcon } from "./components/ModelIdentityIcon";
import { Onboarding } from "./components/Onboarding";
import { BrandMark } from "./components/ui";
import { chatSessionStore, useActiveChatTitle, useChatStreaming } from "./hooks/useChatSession";
import { useDsbox } from "./hooks/useDsbox";
import { formatModelName } from "./lib/format";
import { identifyModel } from "./lib/model-identity";
import { currentDownload, downloadStageLabel, resumableDownload } from "./lib/model-download-state";
import type { ViewId } from "./types";

const ChatView = lazy(() => import("./views/ChatView").then((module) => ({ default: module.ChatView })));
const ModelsView = lazy(() => import("./views/ModelsView").then((module) => ({ default: module.ModelsView })));
const RuntimeView = lazy(() => import("./views/RuntimeView").then((module) => ({ default: module.RuntimeView })));
const AgentsView = lazy(() => import("./views/AgentsView").then((module) => ({ default: module.AgentsView })));
const MonitorView = lazy(() => import("./views/MonitorView").then((module) => ({ default: module.MonitorView })));
const SettingsView = lazy(() => import("./views/SettingsView").then((module) => ({ default: module.SettingsView })));

const navigation: Array<{ id: ViewId; label: string; icon: typeof MessageCircleMore }> = [
  { id: "chat", label: "Chat", icon: MessageCircleMore },
  { id: "models", label: "Models", icon: Boxes },
  { id: "agents", label: "Agents", icon: Workflow },
  { id: "runtime", label: "Server", icon: CirclePower },
  { id: "monitor", label: "Activity", icon: ChartNoAxesCombined }
];

const viewLabels: Record<ViewId, string> = {
  chat: "Chat",
  models: "Models",
  runtime: "Server",
  agents: "Agents",
  monitor: "Activity",
  settings: "Settings"
};

export default function App() {
  const controller = useDsbox();
  const chatStreaming = useChatStreaming();
  const chatTitle = useActiveChatTitle();
  const [view, setView] = useState<ViewId>("chat");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [modelsInitialFilter, setModelsInitialFilter] = useState<"library" | "discover">("library");
  const [onboardingComplete, setOnboardingComplete] = useState(() => window.localStorage.getItem("dsbox:onboarding-complete") === "1");
  const snapshot = controller.snapshot;

  useEffect(() => {
    if (!snapshot?.runtime.modelPresent || onboardingComplete) return;
    window.localStorage.setItem("dsbox:onboarding-complete", "1");
    setOnboardingComplete(true);
  }, [onboardingComplete, snapshot?.runtime.modelPresent]);

  useEffect(() => {
    const title = view === "chat" ? chatTitle : viewLabels[view];
    document.title = `${title} · DSBox`;
  }, [chatTitle, view]);

  const content = useMemo(() => {
    if (!snapshot) return null;
    const shared = { snapshot, controller, onNavigate: setView };
    switch (view) {
      case "chat": return <ChatView {...shared} />;
      case "models": return <ModelsView {...shared} initialFilter={modelsInitialFilter} />;
      case "runtime": return <RuntimeView {...shared} />;
      case "agents": return <AgentsView {...shared} />;
      case "monitor": return <MonitorView {...shared} />;
      case "settings": return <SettingsView {...shared} />;
    }
  }, [controller, modelsInitialFilter, snapshot, view]);

  if (!snapshot) {
    return (
      <div className="boot-screen">
        <BrandMark />
        <div className="boot-screen__wordmark">DSBox</div>
        <div className="boot-screen__line"><span /></div>
        <p>Opening DSBox…</p>
        {controller.error && <div className="boot-screen__error">{controller.error}</div>}
      </div>
    );
  }

  const activeTitle = view === "chat" ? chatTitle : viewLabels[view];
  const latest = snapshot.metrics.at(-1);
  const activeDownload = currentDownload(snapshot.downloads);
  const interruptedDownload = activeDownload ? null : resumableDownload(snapshot.downloads);
  const runtimeModelIdentity = identifyModel(snapshot.config.model.id, snapshot.config.model.path);
  return (
    <div className={`app-shell ${sidebarCollapsed ? "app-shell--collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar__brand">
          <BrandMark small />
          <AnimatePresence initial={false}>
            {!sidebarCollapsed && (
              <motion.div
                className="sidebar__wordmark"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -6 }}
              >
                <strong>DSBox</strong>
              </motion.div>
            )}
          </AnimatePresence>
          <button
            className="sidebar__collapse icon-button"
            onClick={() => setSidebarCollapsed((current) => !current)}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>

        <nav className="sidebar__nav" aria-label="Primary navigation">
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
                <i className="nav-item__icon" aria-hidden="true"><Icon size={17} strokeWidth={1.75} /></i>
                <span>{item.label}</span>
                {item.id === "runtime" && snapshot.runtime.phase === "error" && <i className="nav-alert" />}
                {item.id === "models" && activeDownload && <small>{Math.round((activeDownload.downloadedBytes / Math.max(activeDownload.totalBytes, 1)) * 100)}%</small>}
                {item.id === "models" && interruptedDownload && <small>{interruptedDownload.stage === "error" ? "retry" : "paused"}</small>}
                {item.id === "chat" && chatStreaming && <small>live</small>}
                {item.id === "monitor" && snapshot.runtime.phase === "running" && snapshot.activity.stage !== "idle" && (
                  <small>{latest?.tokensPerSecond ? `${latest.tokensPerSecond.toFixed(1)} t/s` : "live"}</small>
                )}
              </button>
            );
          })}
        </nav>

        {view === "chat" && <ChatSidebarThreads onOpenChat={() => setView("chat")} />}

        <div className="sidebar__spacer" />
        <button
          className={`nav-item nav-item--settings ${view === "settings" ? "nav-item--active" : ""}`}
          onClick={() => setView("settings")}
          title={sidebarCollapsed ? "Settings" : undefined}
          aria-label="Settings"
          aria-current={view === "settings" ? "page" : undefined}
        >
          <i className="nav-item__icon" aria-hidden="true"><SlidersHorizontal size={17} strokeWidth={1.75} /></i>
          <span>Settings</span>
        </button>

        <button className="sidebar__runtime" onClick={() => setView("runtime")} aria-label={`Server: ${snapshot.runtime.phase === "running" ? "on" : "off"}`}>
          <div className="sidebar__runtime-head">
            <span className={`sidebar__runtime-model sidebar__runtime-model--${runtimeModelIdentity}`} aria-hidden="true">
              {snapshot.runtime.modelPresent ? <ModelIdentityIcon identity={runtimeModelIdentity} fallback={<HardDrive size={14} />} /> : <HardDrive size={14} />}
              <i className={`status-orb status-orb--${snapshot.runtime.phase}`} />
            </span>
            <div>
              <strong>{snapshot.runtime.modelPresent ? formatModelName(snapshot.config.model.id) : "Choose a model"}</strong>
              <span>{activeDownload ? downloadStageLabel(activeDownload.stage) : interruptedDownload ? downloadStageLabel(interruptedDownload.stage) : snapshot.runtime.phase === "running" ? "Ready" : snapshot.runtime.currentTask ?? (snapshot.runtime.modelPresent ? "DSBox is off" : "Choose a local file or catalog model")}</span>
            </div>
          </div>
          <ChevronRight size={15} />
        </button>
      </aside>

      <main className="main-area">
        <header className={`topbar ${view === "settings" ? "topbar--settings" : ""}`}>
          <h1 className="sr-only">{activeTitle}</h1>
          {chatStreaming && view !== "chat" && (
            <div className="topbar__actions">
              <button className="topbar__generation-stop" onClick={chatSessionStore.stop} aria-label="Stop the active chat generation" title="Stop generation">
                <CircleStop size={15} />
              </button>
            </div>
          )}
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
              <Suspense fallback={<div className="view-loading"><BrandMark small /><span>Loading view…</span></div>}>
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
            <div><strong>Operation failed</strong><p>{controller.error}</p></div>
            <button onClick={controller.clearError} aria-label="Close"><X size={16} /></button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className={`connection-indicator ${controller.connected ? "connection-indicator--on" : ""}`} title={controller.connected ? "Live updates connected" : "Reconnecting…"}>
        <span />
      </div>

      <AnimatePresence>
        {!snapshot.runtime.modelPresent && !onboardingComplete && (
          <Onboarding
            snapshot={snapshot}
            onChooseLocal={() => {
              window.localStorage.setItem("dsbox:onboarding-complete", "1");
              setOnboardingComplete(true);
              setModelsInitialFilter("library");
              setView("models");
            }}
            onChooseCatalog={() => {
              window.localStorage.setItem("dsbox:onboarding-complete", "1");
              setOnboardingComplete(true);
              setModelsInitialFilter("discover");
              setView("models");
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
