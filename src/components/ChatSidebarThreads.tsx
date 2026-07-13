import { Check, MoreHorizontal, Pencil, Plus, Search, ShieldCheck, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
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
  const [menuThreadId, setMenuThreadId] = useState<string | null>(null);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [deleteThread, setDeleteThread] = useState<ChatThread | null>(null);

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
    setMenuThreadId(null);
    onOpenChat();
  };

  return (
    <section className="sidebar-chats" aria-label="Local chat history">
      <div className="sidebar-chats__head">
        <span>Chats</span>
        <button onClick={startNewThread} disabled={chat.streaming || chat.messages.length === 0} aria-label="New chat" title={chat.streaming ? "Stop generation before starting a new chat" : "New chat"}><Plus size={15} /></button>
      </div>
      <label className="sidebar-chat-search">
        <Search size={13} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search chats" aria-label="Search chats" />
        {query && <button onClick={() => setQuery("")} aria-label="Clear chat search"><X size={12} /></button>}
      </label>

      <div className="sidebar-chats__list">
        {groups.length ? groups.map((group) => (
          <div className="sidebar-chat-group" key={group.label}>
            <span>{group.label}</span>
            {group.threads.map((thread) => {
              const active = thread.id === chat.activeThreadId;
              const menuOpen = menuThreadId === thread.id;
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
                          setMenuThreadId(null);
                        }}
                        aria-current={active ? "page" : undefined}
                        title={thread.title}
                      >
                        <span>{thread.title}</span>
                        {active && chat.streaming && <i title="Generating" />}
                      </button>
                    )}
                    {!editing && <button className="sidebar-thread__more" onClick={() => setMenuThreadId(menuOpen ? null : thread.id)} aria-label={`Actions for ${thread.title}`} aria-expanded={menuOpen}><MoreHorizontal size={15} /></button>}
                  </div>
                  {menuOpen && (
                    <div className="sidebar-thread__menu">
                      <button onClick={() => { setEditingThreadId(thread.id); setTitleDraft(thread.title); setMenuThreadId(null); }}><Pencil size={12} /> Rename</button>
                      <button className="danger" disabled={chat.streaming} onClick={() => { setDeleteThread(thread); setMenuThreadId(null); }}><Trash2 size={12} /> Delete</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )) : (
          <div className="sidebar-chats__empty"><Search size={15} /><span>No matching chats</span></div>
        )}
      </div>

      <div className="sidebar-chats__privacy"><ShieldCheck size={12} /><span>Local only · this Mac</span></div>

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
