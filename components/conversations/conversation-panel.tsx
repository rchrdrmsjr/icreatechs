"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, SyntheticEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ChevronDown,
  Copy,
  History,
  Loader2,
  Plus,
  Send,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import { io, type Socket } from "socket.io-client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { PastConversationsDialog } from "@/components/conversations/past-conversations-dialog";
import { useEditorStore } from "@/lib/editor-store";
import { createClient } from "@/utils/supabase/client";

type ConversationSummary = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};

type ConversationMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: "processing" | "completed" | "cancelled" | "failed";
  created_at: string;
  updated_at?: string;
  model?: string | null;
  clientId?: string;
  optimistic?: boolean;
};

type StreamEvent = {
  type?: "token" | "done" | "error";
  messageId: string;
  conversationId: string;
  projectId?: string;
  delta?: string;
  error?: string;
};

type FileRecord = {
  id: string;
  name: string;
  path: string;
  type: "file" | "folder";
  parent_id: string | null;
};

interface ConversationPanelProps {
  projectId: string;
  aiProvider?: "gemini" | "groq";
  aiModel?: string;
}

const DEFAULT_CONVERSATION_TITLE = "New conversation";
const MODEL_OPTIONS: Record<NonNullable<ConversationPanelProps["aiProvider"]>, string[]> = {
  gemini: ["gemini-2.5-flash", "gemini-2.0-flash"],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
};

type MentionInfo = {
  start: number;
  end: number;
  trigger: "@" | "/";
  query: string;
};

const getLanguageFromName = (name: string) => {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
      return "typescript";
    case "tsx":
      return "typescript";
    case "js":
      return "javascript";
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "html":
      return "html";
    case "css":
    case "scss":
    case "sass":
      return "scss";
    case "md":
    case "mdx":
      return "markdown";
    case "py":
      return "python";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "java":
      return "java";
    case "cs":
      return "csharp";
    case "cpp":
    case "c":
    case "h":
      return "cpp";
    case "xml":
      return "xml";
    default:
      return "plaintext";
  }
};

const stripTrailingPunctuation = (value: string) => {
  const match = /^(.*?)([.,!?;:]+)?$/.exec(value);
  if (!match) return { base: value, trailing: "" };
  return { base: match[1], trailing: match[2] ?? "" };
};

const findMentionAtCursor = (value: string, cursor: number): MentionInfo | null => {
  const left = value.slice(0, cursor);
  const match = /(^|\s)([@/])([^\s]*)$/.exec(left);
  if (!match) return null;

  const trigger = match[2] as "@" | "/";
  const query = match[3] ?? "";
  const leading = match[1] ?? "";
  const triggerIndex = left.length - match[0].length + leading.length;

  return {
    start: triggerIndex,
    end: cursor,
    trigger,
    query,
  };
};

const linkifyMentions = (
  value: string,
  filesByPath: Map<string, FileRecord>,
): string => {
  if (!value) return value;
  const parts = value.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part) => {
      if (part.startsWith("```")) return part;
      return part.replace(/(^|[\s(])([@/])([^\s)]+)/g, (match, prefix, trigger, rawPath) => {
        const { base, trailing } = stripTrailingPunctuation(rawPath);
        const file = filesByPath.get(base);
        if (!file || file.type !== "file") return match;
        return `${prefix}[${trigger}${base}](file:${file.id})${trailing}`;
      });
    })
    .join("");
};

const tokenizeMentions = (
  value: string,
  filesByPath: Map<string, FileRecord>,
): Array<
  | { type: "text"; value: string }
  | { type: "mention"; label: string; file: FileRecord }
> => {
  if (!value) return [{ type: "text", value: "" }];
  const tokens: Array<
    | { type: "text"; value: string }
    | { type: "mention"; label: string; file: FileRecord }
  > = [];
  const regex = /(^|[\s(])([@/])([^\s)]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(value)) !== null) {
    const prefix = match[1] ?? "";
    const trigger = match[2];
    const rawPath = match[3];
    const matchStart = match.index;
    const tokenStart = matchStart + prefix.length;
    const tokenEnd = tokenStart + trigger.length + rawPath.length;
    const before = value.slice(lastIndex, matchStart) + prefix;
    if (before) {
      tokens.push({ type: "text", value: before });
    }
    const { base, trailing } = stripTrailingPunctuation(rawPath);
    const file = filesByPath.get(base);
    if (file && file.type === "file") {
      tokens.push({ type: "mention", label: `${trigger}${base}`, file });
      if (trailing) {
        tokens.push({ type: "text", value: trailing });
      }
    } else {
      tokens.push({ type: "text", value: `${trigger}${rawPath}` });
    }
    lastIndex = tokenEnd;
  }

  if (lastIndex < value.length) {
    tokens.push({ type: "text", value: value.slice(lastIndex) });
  }

  return tokens;
};

export const ConversationPanel = ({
  projectId,
  aiProvider = "gemini",
  aiModel,
}: ConversationPanelProps) => {
  const [input, setInput] = useState("");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [fileIndex, setFileIndex] = useState<FileRecord[]>([]);
  const [fileIndexLoading, setFileIndexLoading] = useState(false);
  const [fileIndexError, setFileIndexError] = useState<string | null>(null);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pastConversationsOpen, setPastConversationsOpen] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] =
    useState<ConversationPanelProps["aiProvider"]>(aiProvider);
  const [selectedModel, setSelectedModel] = useState<string | undefined>(aiModel);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [socketConnected, setSocketConnected] = useState(false);
  const [realtimeReady, setRealtimeReady] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonRenderStartRef = useRef<number | null>(null);
  const lastFailureIdRef = useRef<string | null>(null);
  const wasProcessingRef = useRef(false);
  const activeConversationIdRef = useRef<string | null>(null);
  const pendingUserMessageRef = useRef<{ id: string; content: string } | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const supabase = useMemo(() => createClient(), []);
  const openFile = useEditorStore((state) => state.openFile);

  const activeConversation = useMemo(
    () =>
      conversations.find((conversation) => conversation.id === activeConversationId) ??
      conversations[0] ??
      null,
    [activeConversationId, conversations],
  );

  const currentAssistantMessage = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant") {
        return message;
      }
    }
    return null;
  }, [messages]);

  const currentAssistantStatus = currentAssistantMessage?.status ?? null;
  const isProcessing = currentAssistantStatus === "processing";
  const showCancel = isProcessing || sending;
  const canCancel = showCancel && !cancelling;
  const canSend = !showCancel && !cancelling && Boolean(input.trim());

  if (typeof performance !== "undefined") {
    buttonRenderStartRef.current = performance.now();
  }

  const lastAssistantMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant" && message.status === "completed") {
        return message.id;
      }
    }
    return null;
  }, [messages]);

  const loadConversations = useCallback(async () => {
    if (!projectId) return;
    setLoadingConversations(true);
    try {
      const response = await fetch(`/api/conversations?projectId=${projectId}`);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to load conversations");
      }
      const list = payload?.conversations ?? [];
      setConversations(list);
      if (!activeConversationId && list.length > 0) {
        setActiveConversationId(list[0].id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load conversations";
      toast.error(message);
    } finally {
      setLoadingConversations(false);
    }
  }, [activeConversationId, projectId]);

  const loadMessages = useCallback(
    async (conversationId: string, silent = false) => {
      if (!conversationId) return null;
      try {
        const response = await fetch(`/api/conversations/${conversationId}/messages`);
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error ?? "Failed to load messages");
        }
        const list = payload?.messages ?? [];
        setMessages(list);
        return list as ConversationMessage[];
      } catch (error) {
        if (!silent) {
          const message =
            error instanceof Error ? error.message : "Failed to load messages";
          toast.error(message);
        }
        return null;
      }
    },
    [],
  );

  const loadFileIndex = useCallback(async () => {
    if (!projectId) return;
    setFileIndexLoading(true);
    setFileIndexError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/files`);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to load project files");
      }
      setFileIndex(payload?.files ?? []);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load project files";
      setFileIndexError(message);
    } finally {
      setFileIndexLoading(false);
    }
  }, [projectId]);

  const sortMessages = useCallback((list: ConversationMessage[]) => {
    return [...list].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  }, []);

  const upsertMessage = useCallback(
    (incoming: ConversationMessage) => {
      setMessages((prev) => {
        if (incoming.role === "user") {
          const pending = pendingUserMessageRef.current;
          const incomingContent = incoming.content ?? "";
          if (pending && incomingContent && incomingContent === pending.content) {
            const pendingIndex = prev.findIndex((item) => item.id === pending.id);
            if (pendingIndex !== -1) {
              const next = [...prev];
              next[pendingIndex] = {
                ...next[pendingIndex],
                ...incoming,
                optimistic: false,
              };
              pendingUserMessageRef.current = null;
              return sortMessages(next);
            }
          }

          if (incomingContent) {
            const incomingTime = incoming.created_at
              ? Date.parse(incoming.created_at)
              : NaN;
            let bestIndex = -1;
            let bestDiff = Number.POSITIVE_INFINITY;

            prev.forEach((item, index) => {
              if (item.role !== "user" || !item.optimistic) return;
              if (item.content !== incomingContent) return;
              const itemTime = item.created_at ? Date.parse(item.created_at) : NaN;
              const diff = Number.isFinite(incomingTime) && Number.isFinite(itemTime)
                ? Math.abs(incomingTime - itemTime)
                : 0;
              if (diff < bestDiff) {
                bestDiff = diff;
                bestIndex = index;
              }
            });

            if (bestIndex !== -1 && (!Number.isFinite(bestDiff) || bestDiff <= 15000)) {
              const next = [...prev];
              next[bestIndex] = {
                ...next[bestIndex],
                ...incoming,
                optimistic: false,
              };
              return sortMessages(next);
            }
          }
        }

        const index = prev.findIndex((item) => item.id === incoming.id);
        if (index === -1) {
          return sortMessages([...prev, incoming]);
        }

        const next = [...prev];
        const existing = next[index];
        const merged = { ...existing, ...incoming };
        if (
          typeof existing.content === "string" &&
          typeof incoming.content === "string"
        ) {
          if (incoming.content.length < existing.content.length) {
            merged.content = existing.content;
          }
        } else if (existing.content && !incoming.content) {
          merged.content = existing.content;
        }
        next[index] = merged;
        return next;
      });
    },
    [sortMessages],
  );

  const updateConversation = useCallback(
    (incoming: ConversationSummary) => {
      setConversations((prev) =>
        prev.map((item) =>
          item.id === incoming.id ? { ...item, ...incoming } : item,
        ),
      );
    },
    [],
  );

  const applyStreamDelta = useCallback((payload: StreamEvent) => {
    if (!payload?.messageId || !payload?.delta) return;

    setMessages((prev) => {
      let next = [...prev];
      let index = next.findIndex((item) => item.id === payload.messageId);

      if (index === -1) {
        index = next.findIndex(
          (item) => item.role === "assistant" && item.status === "processing",
        );
        if (index === -1) {
          return prev;
        }
        next[index] = { ...next[index], id: payload.messageId };
      }

      next = next.filter(
        (item, itemIndex) => itemIndex === index || item.id !== payload.messageId,
      );

      next[index] = {
        ...next[index],
        content: `${next[index].content ?? ""}${payload.delta}`,
        status: "processing",
      };

      return next;
    });
  }, []);

  const markStreamDone = useCallback((payload: StreamEvent) => {
    if (!payload?.messageId) return;
    setMessages((prev) =>
      prev.map((item) =>
        item.id === payload.messageId
          ? { ...item, status: "completed" }
          : item,
      ),
    );
  }, []);

  const markStreamError = useCallback((payload: StreamEvent) => {
    if (!payload?.messageId) return;
    setMessages((prev) =>
      prev.map((item) =>
        item.id === payload.messageId
          ? {
              ...item,
              status: "failed",
              content:
                payload.error ||
                item.content ||
                "Something went wrong. Try again.",
            }
          : item,
      ),
    );
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    void loadFileIndex();
  }, [loadFileIndex]);

  useEffect(() => {
    if (activeConversation?.id) {
      void loadMessages(activeConversation.id);
    } else {
      setMessages([]);
    }
  }, [activeConversation?.id, loadMessages]);

  useEffect(() => {
    activeConversationIdRef.current = activeConversation?.id ?? null;
  }, [activeConversation?.id]);

  useEffect(() => {
    pendingUserMessageRef.current = null;
  }, [activeConversation?.id]);

  useEffect(() => {
    setSelectedProvider(aiProvider ?? "gemini");
  }, [aiProvider]);

  useEffect(() => {
    setSelectedModel(aiModel);
  }, [aiModel]);

  useEffect(() => {
    const socketUrl = process.env.NEXT_PUBLIC_SOCKET_SERVER_URL;
    if (!socketUrl) {
      return;
    }

    let mounted = true;

    const connectSocket = async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const accessToken = data.session?.access_token;

        if (!mounted) return;

        const socket = io(socketUrl, {
          transports: ["websocket"],
          auth: accessToken ? { accessToken } : undefined,
        });

        socketRef.current = socket;

        socket.on("connect", () => {
          setSocketConnected(true);
          const currentConversationId = activeConversationIdRef.current;
          if (currentConversationId) {
            socket.emit("join", { conversationId: currentConversationId });
          }
        });

        socket.on("disconnect", () => {
          setSocketConnected(false);
        });

        socket.on("connect_error", () => {
          setSocketConnected(false);
        });

        socket.on("message:token", applyStreamDelta);
        socket.on("message:done", markStreamDone);
        socket.on("message:error", markStreamError);
      } catch (error) {
        console.warn("Failed to initialize socket connection", error);
      }
    };

    void connectSocket();

    return () => {
      mounted = false;
      const socket = socketRef.current;
      if (socket) {
        socket.off("message:token", applyStreamDelta);
        socket.off("message:done", markStreamDone);
        socket.off("message:error", markStreamError);
        socket.disconnect();
      }
      socketRef.current = null;
      setSocketConnected(false);
    };
  }, [applyStreamDelta, markStreamDone, markStreamError, supabase]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !activeConversation?.id) return;
    socket.emit("join", { conversationId: activeConversation.id });
    return () => {
      socket.emit("leave", { conversationId: activeConversation.id });
    };
  }, [activeConversation?.id]);

  useEffect(() => {
    if (!activeConversation?.id) {
      setRealtimeReady(false);
      return;
    }

    const channel = supabase
      .channel(`conversation:${activeConversation.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${activeConversation.id}`,
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const removedId = (payload.old as { id?: string })?.id;
            if (removedId) {
              setMessages((prev) =>
                prev.filter((item) => item.id !== removedId),
              );
            }
            return;
          }

          const nextMessage = payload.new as ConversationMessage | null;
          if (nextMessage?.id) {
            upsertMessage(nextMessage);
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "conversations",
          filter: `id=eq.${activeConversation.id}`,
        },
        (payload) => {
          const nextConversation = payload.new as ConversationSummary | null;
          if (nextConversation?.id) {
            updateConversation(nextConversation);
          }
        },
      )
      .subscribe((status) => {
        setRealtimeReady(status === "SUBSCRIBED");
      });

    return () => {
      supabase.removeChannel(channel);
      setRealtimeReady(false);
    };
  }, [activeConversation?.id, supabase, upsertMessage, updateConversation]);

  useEffect(() => {
    if (!activeConversation?.id || !isProcessing) return;
    if (realtimeReady || socketConnected) return;
    const interval = setInterval(() => {
      void loadMessages(activeConversation.id, true);
    }, 1500);
    return () => clearInterval(interval);
  }, [activeConversation?.id, isProcessing, loadMessages, realtimeReady, socketConnected]);

  useEffect(() => {
    if (wasProcessingRef.current && !isProcessing) {
      if (activeConversation?.id) {
        void loadMessages(activeConversation.id, true);
      }
      void loadFileIndex();
      void loadConversations();
    }
    wasProcessingRef.current = isProcessing;
  }, [
    activeConversation?.id,
    isProcessing,
    loadConversations,
    loadFileIndex,
    loadMessages,
  ]);

  useEffect(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "assistant" || message.status !== "failed") {
        continue;
      }

      if (lastFailureIdRef.current === message.id) {
        break;
      }

      lastFailureIdRef.current = message.id;
      const content = message.content?.trim();
      const normalized = (content ?? "").toLowerCase();
      if (
        normalized.includes("quota") ||
        normalized.includes("rate limit") ||
        normalized.includes("billing")
      ) {
        toast.error(
          content ||
            "AI provider quota exceeded. Check billing or switch providers.",
        );
      } else {
        toast.error(content || "Message failed. Please try again.");
      }
      break;
    }
  }, [messages]);

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current) {
        clearTimeout(copyResetTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const mentionInfo = useMemo(
    () => findMentionAtCursor(input, cursorPosition),
    [cursorPosition, input],
  );

  const mentionResults = useMemo(() => {
    if (!mentionInfo) return [];
    const query = mentionInfo.query.trim().toLowerCase();
    const filtered = fileIndex.filter((file) => {
      const path = file.path?.toLowerCase() ?? "";
      const name = file.name?.toLowerCase() ?? "";
      if (!query) return true;
      return path.includes(query) || name.includes(query);
    });

    return filtered
      .sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === "folder" ? -1 : 1;
        }
        return a.path.localeCompare(b.path);
      })
      .slice(0, 8);
  }, [fileIndex, mentionInfo]);

  const showMentionMenu = Boolean(mentionInfo) && !showCancel;

  useEffect(() => {
    if (!mentionInfo) return;
    setMentionIndex(0);
  }, [mentionInfo?.query, mentionInfo?.trigger]);

  const handleCreateConversation = useCallback(async () => {
    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title: DEFAULT_CONVERSATION_TITLE }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to create conversation");
      }
      const newConversation = payload?.conversation as ConversationSummary;
      setConversations((prev) => [newConversation, ...prev]);
      setActiveConversationId(newConversation.id);
      return newConversation.id;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to create conversation";
      toast.error(message);
      return null;
    }
  }, [projectId]);

  const handleCancel = useCallback(async () => {
    try {
      await fetch("/api/messages/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (activeConversation?.id) {
        await loadMessages(activeConversation.id, true);
      }
    } catch {
      toast.error("Unable to cancel request");
    }
  }, [activeConversation?.id, loadMessages, projectId]);

  const handleSubmit = useCallback(async () => {
    const message = input.trim();
    if (!message) return;

    let conversationId: string | null = activeConversation?.id ?? null;

    if (!conversationId) {
      const createdId = await handleCreateConversation();
      if (!createdId) return;
      conversationId = createdId;
    }

    if (!conversationId) return;

    setSending(true);
    const now = new Date().toISOString();
    const makeTempId = () =>
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `temp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tempUserId = makeTempId();
    const tempAssistantId = makeTempId();
    pendingUserMessageRef.current = { id: tempUserId, content: message };
    setMessages((prev) => [
      ...prev,
      {
        id: tempUserId,
        role: "user",
        content: message,
        status: "completed",
        created_at: now,
        clientId: tempUserId,
        optimistic: true,
      },
      {
        id: tempAssistantId,
        role: "assistant",
        content: "",
        status: "processing",
        created_at: now,
      },
    ]);
    try {
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          message,
          aiProvider: selectedProvider,
          model: selectedModel ?? null,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error ?? "Message failed to send");
      }
      const serverMessageId = payload?.messageId as string | undefined;
      if (serverMessageId) {
        setMessages((prev) => {
          const processingIndex = prev.findIndex(
            (item) => item.role === "assistant" && item.status === "processing",
          );
          if (processingIndex === -1) return prev;

          const existingIndex = prev.findIndex(
            (item) => item.id === serverMessageId,
          );

          const next = [...prev];

          if (existingIndex !== -1 && existingIndex !== processingIndex) {
            next[existingIndex] = {
              ...next[existingIndex],
              ...next[processingIndex],
              id: serverMessageId,
            };
            next.splice(processingIndex, 1);
            return next;
          }

          next[processingIndex] = {
            ...next[processingIndex],
            id: serverMessageId,
          };
          return next;
        });
      }
      setInput("");
      if (!realtimeReady && !socketConnected) {
        await loadMessages(conversationId, true);
      }
      await loadConversations();
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : "Message failed to send";
      toast.error(messageText);
    } finally {
      setSending(false);
    }
  }, [
    activeConversation?.id,
    handleCreateConversation,
    input,
    loadConversations,
    loadMessages,
    realtimeReady,
    selectedModel,
    selectedProvider,
    socketConnected,
  ]);

  const handlePrimaryAction = useCallback(async () => {
    if (showCancel) {
      if (!canCancel) return;
      console.log("[ConversationPanel] Cancel click", {
        conversationId: activeConversation?.id ?? null,
        projectId,
      });
      setSending(false);
      setCancelling(true);
      try {
        await handleCancel();
        setInput("");
      } finally {
        setCancelling(false);
      }
      return;
    }

    if (!canSend) return;
    console.log("[ConversationPanel] Send click", {
      conversationId: activeConversation?.id ?? null,
      projectId,
    });
    await handleSubmit();
  }, [
    activeConversation?.id,
    canCancel,
    canSend,
    handleCancel,
    handleSubmit,
    projectId,
    showCancel,
  ]);

  useEffect(() => {
    if (typeof performance === "undefined") return;
    if (buttonRenderStartRef.current === null) return;
    const durationMs = performance.now() - buttonRenderStartRef.current;
    console.log(
      `[ConversationPanel] ${showCancel ? "Cancel" : "Send"} button render: ${durationMs.toFixed(2)}ms`,
      { disabled: showCancel ? !canCancel : !canSend },
    );
  }, [canCancel, canSend, showCancel]);

  const handleCopyMessage = useCallback(async (message: ConversationMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessageId(message.id);
      toast.success("Copied to clipboard");
      if (copyResetTimeoutRef.current) {
        clearTimeout(copyResetTimeoutRef.current);
      }
      copyResetTimeoutRef.current = setTimeout(() => {
        setCopiedMessageId((current) => (current === message.id ? null : current));
      }, 1500);
    } catch (error) {
      console.error("Failed to copy message", error);
      toast.error("Failed to copy message");
    }
  }, []);

  const filesByPath = useMemo(() => {
    const map = new Map<string, FileRecord>();
    fileIndex.forEach((file) => {
      if (file.path) {
        map.set(file.path, file);
      }
    });
    return map;
  }, [fileIndex]);

  const handleOpenFile = useCallback(
    (file: FileRecord) => {
      if (file.type !== "file") return;
      openFile({
        id: file.id,
        name: file.name,
        path: file.path,
        language: getLanguageFromName(file.name),
      });
    },
    [openFile],
  );

  const handleMentionSelect = useCallback(
    (file: FileRecord) => {
      if (!mentionInfo) return;
      const path = file.path || file.name;
      const after = input.slice(mentionInfo.end);
      const needsSpace = after.length === 0 || !/^\s/.test(after);
      const insertion = `${mentionInfo.trigger}${path}${needsSpace ? " " : ""}`;
      const nextValue = `${input.slice(0, mentionInfo.start)}${insertion}${after}`;
      const nextCursor = mentionInfo.start + insertion.length;

      setInput(nextValue);
      setCursorPosition(nextCursor);

      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [input, mentionInfo],
  );

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setInput(event.target.value);
      setCursorPosition(event.target.selectionStart ?? event.target.value.length);
    },
    [],
  );

  const handleCursorUpdate = useCallback(
    (event: SyntheticEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      setCursorPosition(target.selectionStart ?? target.value.length);
    },
    [],
  );

  const handleTextareaKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (showMentionMenu && mentionResults.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setMentionIndex((current) =>
            Math.min(current + 1, mentionResults.length - 1),
          );
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setMentionIndex((current) => Math.max(current - 1, 0));
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          const selected = mentionResults[mentionIndex];
          if (selected) {
            handleMentionSelect(selected);
          }
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setMentionIndex(0);
          return;
        }
      }

      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void handlePrimaryAction();
      }
    },
    [
      handleMentionSelect,
      handlePrimaryAction,
      mentionIndex,
      mentionResults,
      showMentionMenu,
    ],
  );

  const renderUserMessage = useCallback(
    (content: string) => {
      const tokens = tokenizeMentions(content, filesByPath);
      return (
        <p className="whitespace-pre-wrap">
          {tokens.map((token, index) => {
            if (token.type === "text") {
              return <span key={`text-${index}`}>{token.value}</span>;
            }
            return (
              <button
                key={`mention-${token.file.id}-${index}`}
                type="button"
                onClick={() => handleOpenFile(token.file)}
                className="underline decoration-dotted underline-offset-2"
              >
                {token.label}
              </button>
            );
          })}
        </p>
      );
    },
    [filesByPath, handleOpenFile],
  );

  const renderAssistantMessage = useCallback(
    (content: string) => {
      const linked = linkifyMentions(content, filesByPath);
      return (
        <div className="prose prose-invert prose-sm max-w-none">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => {
                if (href?.startsWith("file:")) {
                  const id = href.slice("file:".length);
                  const file = fileIndex.find((item) => item.id === id);
                  if (file) {
                    return (
                      <button
                        type="button"
                        onClick={() => handleOpenFile(file)}
                        className="text-primary underline decoration-dotted underline-offset-2"
                      >
                        {children}
                      </button>
                    );
                  }
                }
                return (
                  <a href={href} className="text-primary underline" rel="noreferrer">
                    {children}
                  </a>
                );
              },
            }}
          >
            {linked}
          </ReactMarkdown>
        </div>
      );
    },
    [fileIndex, filesByPath, handleOpenFile],
  );

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-background">
      <PastConversationsDialog
        conversations={conversations}
        open={pastConversationsOpen}
        onOpenChange={setPastConversationsOpen}
        onSelect={(conversationId) => setActiveConversationId(conversationId)}
      />
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex flex-col">
          <span className="text-xs text-muted-foreground">AI Conversation</span>
          <span className="text-sm font-medium">
            {activeConversation?.title ?? DEFAULT_CONVERSATION_TITLE}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => setPastConversationsOpen(true)}
            title="Conversation history"
          >
            <History className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={handleCreateConversation}
            title="New conversation"
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-4"
        ref={scrollRef}
      >
        {loadingConversations && !activeConversation ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            Start a prompt to begin this conversation.
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "flex",
                  message.role === "user" ? "justify-end" : "justify-start",
                )}
              >
                <div
                  className={cn(
                    "max-w-[85%] break-words rounded-lg px-3 py-2 text-sm",
                    message.role === "user"
                      ? "bg-foreground text-background"
                      : "bg-muted text-foreground",
                  )}
                >
                  {message.status === "processing" ? (
                    message.role === "assistant" && message.content?.trim() ? (
                      <div className="space-y-2">
                        {renderAssistantMessage(message.content)}
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          <span>Streaming response...</span>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Thinking...</span>
                      </div>
                    )
                  ) : message.status === "cancelled" ? (
                    <span className="text-muted-foreground italic">
                      Request cancelled
                    </span>
                  ) : message.status === "failed" ? (
                    <span className="text-destructive">
                      {message.content?.trim() ||
                        "Something went wrong. Try again."}
                    </span>
                  ) : message.role === "assistant" ? (
                    renderAssistantMessage(message.content)
                  ) : (
                    renderUserMessage(message.content)
                  )}
                </div>
                {message.role === "assistant" &&
                  message.status === "completed" &&
                  message.id === lastAssistantMessageId && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="ml-2"
                      onClick={() => void handleCopyMessage(message)}
                      title={
                        copiedMessageId === message.id ? "Copied" : "Copy response"
                      }
                    >
                      <Copy className="size-3.5" />
                    </Button>
                  )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        <div className="space-y-2">
          <div className="rounded-xl border border-border bg-muted/30 p-2">
            <div className="relative">
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={handleInputChange}
                placeholder="Ask about this project..."
                rows={3}
                disabled={showCancel}
                className="min-h-[88px] resize-none border-0 bg-transparent px-2 py-2 shadow-none focus-visible:border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                onKeyDown={handleTextareaKeyDown}
                onClick={handleCursorUpdate}
                onKeyUp={handleCursorUpdate}
                onSelect={handleCursorUpdate}
              />
              {showMentionMenu && (
                <div className="absolute bottom-full z-20 mb-1 w-full overflow-hidden rounded-md border border-border bg-background shadow-lg">
                  {fileIndexLoading ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      Loading files...
                    </div>
                  ) : fileIndexError ? (
                    <div className="px-3 py-2 text-xs text-destructive">
                      {fileIndexError}
                    </div>
                  ) : mentionResults.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      No matches found
                    </div>
                  ) : (
                    <div className="max-h-48 overflow-y-auto py-1">
                      {mentionResults.map((file, index) => (
                        <button
                          key={file.id}
                          type="button"
                          className={cn(
                            "flex w-full items-center justify-between px-3 py-1.5 text-left text-xs",
                            index === mentionIndex
                              ? "bg-muted text-foreground"
                              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                          )}
                          onMouseEnter={() => setMentionIndex(index)}
                          onClick={() => handleMentionSelect(file)}
                        >
                          <span className="truncate">{file.path}</span>
                          <span className="ml-2 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                            {file.type}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="flex flex-1 flex-wrap items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={showCancel}
                      className="h-7 rounded-full bg-background/60 px-3 text-xs"
                    >
                      <span className="truncate capitalize">
                        {selectedProvider ?? "gemini"}
                      </span>
                      <ChevronDown className="ml-2 size-3.5 opacity-70" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuRadioGroup
                      value={selectedProvider ?? "gemini"}
                      onValueChange={(value) => {
                        if (!value) return;
                        const provider =
                          value as ConversationPanelProps["aiProvider"];
                        setSelectedProvider(provider);
                        setSelectedModel(undefined);
                      }}
                    >
                      <DropdownMenuRadioItem value="gemini">
                        Gemini
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="groq">
                        Groq
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={showCancel}
                      className="h-7 rounded-full bg-background/60 px-3 text-xs"
                    >
                      <span className="truncate">
                        {selectedModel ?? "Auto model"}
                      </span>
                      <ChevronDown className="ml-2 size-3.5 opacity-70" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuRadioGroup
                      value={selectedModel ?? "auto"}
                      onValueChange={(value) => {
                        if (!value || value === "auto") {
                          setSelectedModel(undefined);
                          return;
                        }
                        setSelectedModel(value);
                      }}
                    >
                      <DropdownMenuRadioItem value="auto">
                        Auto model
                      </DropdownMenuRadioItem>
                      {MODEL_OPTIONS[selectedProvider ?? "gemini"].map((model) => (
                        <DropdownMenuRadioItem key={model} value={model}>
                          {model}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <Button
                type="button"
                size="icon"
                variant={showCancel ? "outline" : "default"}
                onClick={handlePrimaryAction}
                disabled={showCancel ? !canCancel : !canSend}
                className="h-9 w-9 rounded-full"
              >
                {showCancel ? (
                  <Square className="size-4" />
                ) : (
                  <Send className="size-4" />
                )}
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {isProcessing
                ? "Assistant is processing..."
                : "Cmd/Ctrl+Enter to send"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
