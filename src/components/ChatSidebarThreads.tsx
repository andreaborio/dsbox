import { Check, MoreHorizontal, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useChatSession } from "../hooks/useChatSession";
import type { ChatThread } from "../types";
import { Button, Modal } from "./ui";

interface Props {
  onOpenChat: () => void;
}
interface ThreadGroup {
  label: string;
  threads: ChatThread[];
}

interface ThreadMenuState {
  threadId: string;
  top: number;
  left: number;
  anchor: HTMLButtonElement;
}

const threadMenuWidth = 152;
const threadMenuHeight = 82;
const threadMenuViewportGap = 8;

function groupThreads(threads: ChatThread[], now: number): ThreadGroup[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const week = today - 6 * 24 * 60 * 60 * 1000;
  const groups: ThreadGroup[] = [
    { label: "Today", threads: [] },
    { label: "Previous 7 days", threads: [] },
    { label: "Older", threads: [] }
  ];
  for (const thread of threads) {
    if (thread.updatedAt >= today) groups[0].threads.push(thread);
    else if (thread.updatedAt >= week) groups[1].threads.push(thread);
    else groups[2].threads.push(thread);
  }
  return groups.filter((group) => group.threads.length);
}

export function ChatSidebarThreads({ onOpenChat }: Props) {
  const chat = useChatSession();
  const [query, setQuery] = useState("");
  const [threadMenu, setThreadMenu] = useState<ThreadMenuState | null>(null);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [deleteThread, setDeleteThread] = useState<ChatThread | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const groups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = [...chat.threads]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .filter((thread) => !normalized || thread.title.toLowerCase().includes(normalized) || thread.messages.some((message) => message.content.toLowerCase().includes(normalized)));
    return groupThreads(filtered, Date.now());
  }, [chat.threads, query]);

  const saveRename = (threadId: string) => {
    if (titleDraft.trim()) chat.renameThread(threadId, titleDraft);
    setEditingThreadId(null);
    setTitleDraft("");
  };

  const startNewThread = () => {
    if (chat.streaming) return;
    chat.newThread();
    setThreadMenu(null);
    onOpenChat();
  };

  const toggleThreadMenu = (threadId: string, anchor: HTMLButtonElement) => {
    if (threadMenu?.threadId === threadId) {
      setThreadMenu(null);
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const opensBelow = window.innerHeight - rect.bottom >= threadMenuHeight + threadMenuViewportGap;
    const top = opensBelow
      ? rect.bottom + 4
      : Math.max(threadMenuViewportGap, rect.top - threadMenuHeight - 4);
    const left = Math.min(
      window.innerWidth - threadMenuWidth - threadMenuViewportGap,
      Math.max(threadMenuViewportGap, rect.right - threadMenuWidth)
    );

    setThreadMenu({ threadId, top, left, anchor });
  };

  useEffect(() => {
    if (!threadMenu) return;

    const closeWithoutRestoringFocus = () => setThreadMenu(null);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || threadMenu.anchor.contains(target)) return;
      closeWithoutRestoringFocus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const anchor = threadMenu.anchor;
      setThreadMenu(null);
      window.requestAnimationFrame(() => anchor.focus());
    };
    const onViewportChange = () => closeWithoutRestoringFocus();
    const focusFrame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });

    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [threadMenu]);

  const menuThread = threadMenu ? chat.threads.find((thread) => thread.id === threadMenu.threadId) ?? null : null;
  const newThreadDisabled = chat.streaming || chat.messages.length === 0;
  const newThreadTitle = chat.streaming
    ? "Stop generation before starting a new chat"
    : chat.messages.length === 0
      ? "This chat is already empty"
      : "Start a new chat";

  const moveMenuFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (!items.length) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  return (
    <section className="sidebar-chats" aria-label="Local chat history">
      <div className="sidebar-chats__head">
        <span>Chats</span>
        <button
          type="button"
          onClick={startNewThread}
          disabled={newThreadDisabled}
          aria-label={newThreadDisabled ? `New chat unavailable: ${newThreadTitle}` : "New chat"}
          title={newThreadTitle}
        >
          <Plus size={15} />
        </button>
      </div>
      <label className="sidebar-chat-search">
        <Search size={13} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search chats" aria-label="Search chats" />
        {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear chat search"><X size={12} /></button>}
      </label>

      <div className="sidebar-chats__list">
        {groups.length ? groups.map((group) => (
          <div className="sidebar-chat-group" key={group.label}>
            <span>{group.label}</span>
            {group.threads.map((thread) => {
              const active = thread.id === chat.activeThreadId;
              const menuOpen = threadMenu?.threadId === thread.id;
              const editing = editingThreadId === thread.id;
              return (
                <div className={`sidebar-thread ${active ? "sidebar-thread--active" : ""} ${menuOpen ? "sidebar-thread--menu" : ""}`} key={thread.id}>
                  <div className="sidebar-thread__row">
                    {editing ? (
                      <form onSubmit={(event) => { event.preventDefault(); saveRename(thread.id); }}>
                        <input
                          value={titleDraft}
                          onChange={(event) => setTitleDraft(event.target.value)}
                          onBlur={() => saveRename(thread.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              setEditingThreadId(null);
                            }
                          }}
                          aria-label={`Rename ${thread.title}`}
                          autoFocus
                        />
                        <button type="submit" aria-label="Save thread name"><Check size={13} /></button>
                      </form>
                    ) : (
                      <button
                        className="sidebar-thread__select"
                        disabled={chat.streaming && !active}
                        onClick={() => {
                          if (active || chat.selectThread(thread.id)) onOpenChat();
                          setThreadMenu(null);
                        }}
                        aria-label={`${thread.title}${active && chat.streaming ? ", generating" : ""}`}
                        aria-current={active ? "page" : undefined}
                        title={thread.title}
                      >
                        <span>{thread.title}</span>
                        {active && chat.streaming && <i aria-hidden="true" />}
                      </button>
                    )}
                    {!editing && (
                      <button
                        type="button"
                        className="sidebar-thread__more"
                        onClick={(event) => toggleThreadMenu(thread.id, event.currentTarget)}
                        aria-label={`Actions for ${thread.title}`}
                        aria-haspopup="menu"
                        aria-controls={menuOpen ? menuId : undefined}
                        aria-expanded={menuOpen}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )) : (
          <div className="sidebar-chats__empty"><Search size={15} /><span>No matching chats</span></div>
        )}
      </div>

      {threadMenu && menuThread && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className="sidebar-thread__menu"
          role="menu"
          aria-label={`Actions for ${menuThread.title}`}
          style={{ top: threadMenu.top, left: threadMenu.left }}
          onKeyDown={moveMenuFocus}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setEditingThreadId(menuThread.id);
              setTitleDraft(menuThread.title);
              setThreadMenu(null);
            }}
          >
            <Pencil size={13} /> Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={chat.streaming}
            onClick={() => {
              setDeleteThread(menuThread);
              setThreadMenu(null);
            }}
          >
            <Trash2 size={13} /> Delete
          </button>
        </div>,
        document.body
      )}

      <Modal
        open={Boolean(deleteThread)}
        onClose={() => setDeleteThread(null)}
        title="Delete this thread?"
        footer={<><Button variant="secondary" onClick={() => setDeleteThread(null)}>Cancel</Button><Button variant="danger" icon={<Trash2 size={14} />} onClick={() => { if (deleteThread) chat.deleteThread(deleteThread.id); setDeleteThread(null); }}>Delete thread</Button></>}
      >
        <div className="delete-thread-confirm"><strong>{deleteThread?.title}</strong><p>This removes the conversation from this browser. It does not affect models, caches, or files on your Mac.</p></div>
      </Modal>
    </section>
  );
}
