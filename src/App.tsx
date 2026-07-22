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
  WifiOff,
  Workflow,
  X
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatSidebarThreads } from "./components/ChatSidebarThreads";
import { ModelIdentityIcon } from "./components/ModelIdentityIcon";
import { Onboarding } from "./components/Onboarding";
import { BrandMark, Button, Modal } from "./components/ui";
import { chatSessionStore, useActiveChatTitle, useChatStreaming } from "./hooks/useChatSession";
import { useDsbox } from "./hooks/useDsbox";
import { formatModelName } from "./lib/format";
import { identifyModel } from "./lib/model-identity";
import { currentDownload, downloadStageLabel, resumableDownload } from "./lib/model-download-state";
import { navigationNeedsSettingsConfirmation } from "./lib/navigation-guard";
import {
  readOnboardingPreference,
  shouldShowOnboarding,
  writeOnboardingPreference,
  type OnboardingPreference
} from "./lib/onboarding-preference";
import { readViewPreference, writeViewPreference } from "./lib/view-preference";
import type { ViewId } from "./types";
import type { SettingsNavigationGuard } from "./views/SettingsView";

const loadChatView = () => import("./views/ChatView").then((module) => ({ default: module.ChatView }));
const loadModelsView = () => import("./views/ModelsView").then((module) => ({ default: module.ModelsView }));
const loadRuntimeView = () => import("./views/RuntimeView").then((module) => ({ default: module.RuntimeView }));
const loadAgentsView = () => import("./views/AgentsView").then((module) => ({ default: module.AgentsView }));
const loadMonitorView = () => import("./views/MonitorView").then((module) => ({ default: module.MonitorView }));
const loadSettingsView = () => import("./views/SettingsView").then((module) => ({ default: module.SettingsView }));

const ChatView = lazy(loadChatView);
const ModelsView = lazy(loadModelsView);
const RuntimeView = lazy(loadRuntimeView);
const AgentsView = lazy(loadAgentsView);
const MonitorView = lazy(loadMonitorView);
const SettingsView = lazy(loadSettingsView);

const viewLoaders: Record<ViewId, () => Promise<unknown>> = {
  chat: loadChatView,
  models: loadModelsView,
  runtime: loadRuntimeView,
  agents: loadAgentsView,
  monitor: loadMonitorView,
  settings: loadSettingsView
};

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

function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timeout = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(timeout);
  }, [active, delayMs]);

  return visible;
}

function ViewSkeleton({ label }: { label: string }) {
  return (
    <div className="view-skeleton" role="status" aria-label={`Loading ${label}`}>
      <span className="sr-only">Loading {label}…</span>
      <div className="view-skeleton__header">
        <i />
        <i />
      </div>
      <div className="view-skeleton__body">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

export default function App() {
  const controller = useDsbox();
  const chatStreaming = useChatStreaming();
  const chatTitle = useActiveChatTitle();
  const [view, setView] = useState<ViewId>(() => readViewPreference(window.localStorage));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [modelsInitialFilter, setModelsInitialFilter] = useState<"library" | "discover">("library");
  const [onboardingPreference, setOnboardingPreference] = useState<OnboardingPreference>(() => readOnboardingPreference(window.localStorage));
  const [onboardingHiddenForSession, setOnboardingHiddenForSession] = useState(false);
  const [pendingView, setPendingView] = useState<ViewId | null>(null);
  const [guardSaving, setGuardSaving] = useState(false);
  const settingsGuardRef = useRef<SettingsNavigationGuard | null>(null);
  const snapshot = controller.snapshot;
  const booted = Boolean(snapshot);
  const showConnectionWarning = useDelayedFlag(controller.connectionStatus === "reconnecting", 2500);
  const commitNavigation = useCallback((nextView: ViewId) => {
    setView(nextView);
    writeViewPreference(window.localStorage, nextView);
  }, []);
  const navigate = useCallback((nextView: ViewId) => {
    if (nextView === view) return;
    if (navigationNeedsSettingsConfirmation(view, nextView, settingsGuardRef.current?.isDirty() ?? false)) {
      setPendingView(nextView);
      return;
    }
    commitNavigation(nextView);
  }, [commitNavigation, view]);
  const registerSettingsGuard = useCallback((guard: SettingsNavigationGuard | null) => {
    settingsGuardRef.current = guard;
  }, []);

  const discardAndNavigate = useCallback(() => {
    if (!pendingView) return;
    settingsGuardRef.current?.discard();
    const target = pendingView;
    setPendingView(null);
    commitNavigation(target);
  }, [commitNavigation, pendingView]);

  const saveAndNavigate = useCallback(async () => {
    if (!pendingView || !settingsGuardRef.current) return;
    const target = pendingView;
    setGuardSaving(true);
    try {
      await settingsGuardRef.current.save();
      setPendingView(null);
      commitNavigation(target);
    } finally {
      setGuardSaving(false);
    }
  }, [commitNavigation, pendingView]);

  useEffect(() => {
    if (!snapshot?.runtime.modelPresent || onboardingPreference === "completed") return;
    writeOnboardingPreference(window.localStorage, "completed");
    setOnboardingPreference("completed");
  }, [onboardingPreference, snapshot?.runtime.modelPresent]);

  useEffect(() => {
    const title = view === "chat" ? chatTitle : viewLabels[view];
    document.title = `${title} · Hebrus Studio`;
  }, [chatTitle, view]);

  useEffect(() => {
    void viewLoaders[view]().catch(() => undefined);
  }, [view]);

  useEffect(() => {
    if (!booted) return;
    const preloadRemainingViews = () => {
      for (const [candidate, loader] of Object.entries(viewLoaders) as Array<[ViewId, () => Promise<unknown>]>) {
        if (candidate !== view) void loader().catch(() => undefined);
      }
    };
    if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(preloadRemainingViews, { timeout: 1_500 });
      return () => window.cancelIdleCallback(idleId);
    }
    const timeoutId = window.setTimeout(preloadRemainingViews, 250);
    return () => window.clearTimeout(timeoutId);
  }, [booted]);

  const content = useMemo(() => {
    if (!snapshot) return null;
    const shared = { snapshot, controller, onNavigate: navigate };
    switch (view) {
      case "chat": return <ChatView {...shared} />;
      case "models": return <ModelsView {...shared} initialFilter={modelsInitialFilter} />;
      case "runtime": return <RuntimeView {...shared} />;
      case "agents": return <AgentsView {...shared} />;
      case "monitor": return <MonitorView {...shared} />;
      case "settings": return <SettingsView {...shared} onNavigationGuardChange={registerSettingsGuard} />;
    }
  }, [controller, modelsInitialFilter, navigate, registerSettingsGuard, snapshot, view]);

  if (!snapshot) {
    return (
      <div className="boot-screen">
        <BrandMark />
        <div className="boot-screen__wordmark">Hebrus Studio</div>
        <div className="boot-screen__line"><span /></div>
        <p>Opening Hebrus Studio…</p>
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
          <AnimatePresence initial={false}>
            {!sidebarCollapsed && (
              <motion.div
                className="sidebar__wordmark"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -6 }}
              >
                <strong>Hebrus Studio</strong>
              </motion.div>
            )}
          </AnimatePresence>
          <button
            className="sidebar__collapse icon-button"
            onClick={() => setSidebarCollapsed((current) => !current)}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
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
                onClick={() => navigate(item.id)}
                title={item.label}
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

        {view === "chat" && <ChatSidebarThreads onOpenChat={() => navigate("chat")} />}

        <div className="sidebar__spacer" />
        <button
          className={`nav-item nav-item--settings ${view === "settings" ? "nav-item--active" : ""}`}
          onClick={() => navigate("settings")}
          title="Settings"
          aria-label="Settings"
          aria-current={view === "settings" ? "page" : undefined}
        >
          <i className="nav-item__icon" aria-hidden="true"><SlidersHorizontal size={17} strokeWidth={1.75} /></i>
          <span>Settings</span>
        </button>

        <button
          className="sidebar__runtime"
          onClick={() => navigate("runtime")}
          aria-label={`Server: ${snapshot.runtime.phase === "running" ? "on" : "off"}`}
          title={`Server: ${snapshot.runtime.phase === "running" ? "on" : "off"} · ${snapshot.runtime.modelPresent ? formatModelName(snapshot.config.model.id) : "Choose a model"}`}
        >
          <div className="sidebar__runtime-head">
            <span className={`sidebar__runtime-model sidebar__runtime-model--${runtimeModelIdentity}`} aria-hidden="true">
              {snapshot.runtime.modelPresent ? <ModelIdentityIcon identity={runtimeModelIdentity} fallback={<HardDrive size={14} />} /> : <HardDrive size={14} />}
              <i className={`status-orb status-orb--${snapshot.runtime.phase}`} />
            </span>
            <div>
              <strong>{snapshot.runtime.modelPresent ? formatModelName(snapshot.config.model.id) : "Choose a model"}</strong>
              <span>{activeDownload ? downloadStageLabel(activeDownload.stage) : interruptedDownload ? downloadStageLabel(interruptedDownload.stage) : snapshot.runtime.phase === "running" ? "Ready" : snapshot.runtime.currentTask ?? (snapshot.runtime.modelPresent ? "Hebrus Server is off" : "Choose a local file or catalog model")}</span>
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
              <Suspense fallback={<ViewSkeleton label={activeTitle} />}>
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

      <Modal
        open={pendingView !== null}
        onClose={() => { if (!guardSaving) setPendingView(null); }}
        title="Unsaved settings"
        footer={(
          <>
            <Button variant="ghost" disabled={guardSaving} onClick={() => setPendingView(null)}>Cancel</Button>
            <Button variant="secondary" disabled={guardSaving} onClick={discardAndNavigate}>Discard changes</Button>
            <Button variant="primary" loading={guardSaving} onClick={() => void saveAndNavigate().catch(() => undefined)}>
              {settingsGuardRef.current?.requiresRestart ? "Save and restart" : "Save changes"}
            </Button>
          </>
        )}
      >
        <p className="navigation-guard-copy">
          {settingsGuardRef.current?.requiresRestart
            ? "Save and restart Hebrus Studio before leaving, or discard the changes you made."
            : "Save your changes before leaving, or discard them and continue."}
        </p>
      </Modal>

      <AnimatePresence>
        {showConnectionWarning && (
          <motion.div
            className="connection-banner"
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
          >
            <WifiOff size={16} />
            <div>
              <strong>Live updates paused</strong>
              <span>Visible values may be out of date. Reconnecting automatically…</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className={`connection-indicator ${controller.connected ? "connection-indicator--on" : ""}`} title={controller.connected ? "Live updates connected" : controller.connectionStatus === "connecting" ? "Connecting to live updates…" : "Reconnecting…"}>
        <span />
      </div>

      <AnimatePresence>
        {shouldShowOnboarding({
          modelPresent: snapshot.runtime.modelPresent,
          preference: onboardingPreference,
          hiddenForSession: onboardingHiddenForSession
        }) && (
          <Onboarding
            snapshot={snapshot}
            onChooseLocal={() => {
              setOnboardingHiddenForSession(true);
              setModelsInitialFilter("library");
              navigate("models");
            }}
            onChooseCatalog={() => {
              setOnboardingHiddenForSession(true);
              setModelsInitialFilter("discover");
              navigate("models");
            }}
            onDismiss={() => {
              writeOnboardingPreference(window.localStorage, "dismissed");
              setOnboardingPreference("dismissed");
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
