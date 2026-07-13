import { useSyncExternalStore } from "react";
import { ChatSessionStore } from "../lib/chat-session";

function localStorageOrNull() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const chatSessionStore = new ChatSessionStore({ storage: localStorageOrNull() });

export function useChatSession() {
  const snapshot = useSyncExternalStore(chatSessionStore.subscribe, chatSessionStore.getSnapshot, chatSessionStore.getSnapshot);
  return {
    ...snapshot,
    setInput: chatSessionStore.setInput,
    setThinking: chatSessionStore.setThinking,
    send: chatSessionStore.send,
    stop: chatSessionStore.stop,
    newThread: chatSessionStore.newThread,
    selectThread: chatSessionStore.selectThread,
    renameThread: chatSessionStore.renameThread,
    deleteThread: chatSessionStore.deleteThread
  };
}

export function useChatStreaming(): boolean {
  return useSyncExternalStore(
    chatSessionStore.subscribe,
    () => chatSessionStore.getSnapshot().streaming,
    () => false
  );
}
