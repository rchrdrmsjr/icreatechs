"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { RefreshCw } from "lucide-react";

import { createClient } from "@/utils/supabase/client";
import { Button } from "@/components/ui/button";

import "@xterm/xterm/css/xterm.css";

type TerminalShell = "powershell" | "cmd" | "gitbash";

type StartedEvent = {
  sessionId: string;
  shell: TerminalShell;
  cwd: string;
};

type DataEvent = {
  sessionId: string;
  data: string;
};

type ExitEvent = {
  sessionId: string;
  code: number | null;
  signal: string | null;
};

type ErrorEvent = {
  sessionId?: string;
  error: string;
};

export const PreviewTerminal = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const selectedShellRef = useRef<TerminalShell>("powershell");

  const [selectedShell, setSelectedShell] = useState<TerminalShell>("powershell");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string>("");
  const [connected, setConnected] = useState(false);
  const [starting, setStarting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const supabase = useMemo(() => createClient(), []);
  const socketUrl = process.env.NEXT_PUBLIC_SOCKET_SERVER_URL;

  const writeLine = useCallback((text: string) => {
    if (!terminalRef.current) return;
    terminalRef.current.write(`${text}\r\n`);
  }, []);

  const startTerminal = useCallback(
    (shell: TerminalShell) => {
      const socket = socketRef.current;
      if (!socket) return;

      const previousSessionId = sessionIdRef.current;
      if (previousSessionId) {
        socket.emit("terminal:stop", { sessionId: previousSessionId });
      }

      const nextSessionId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `terminal-${Date.now()}`;

      setStarting(true);
      setErrorMessage(null);
      setSessionId(nextSessionId);
      sessionIdRef.current = nextSessionId;
      setCwd("");

      terminalRef.current?.reset();
      writeLine(`Starting ${shell}...`);

      socket.emit("terminal:start", {
        sessionId: nextSessionId,
        shell,
      });
    },
    [writeLine],
  );

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    selectedShellRef.current = selectedShell;
  }, [selectedShell]);

  useEffect(() => {
    if (!socketUrl) {
      return;
    }

    let mounted = true;

    const connectSocket = async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!mounted) return;
        const accessToken = data.session?.access_token;

        const socket = io(socketUrl, {
          transports: ["websocket"],
          auth: accessToken ? { accessToken } : undefined,
        });
        socketRef.current = socket;

        socket.on("connect", () => {
          setConnected(true);
          startTerminal(selectedShellRef.current);
        });

        socket.on("disconnect", () => {
          setConnected(false);
        });

        socket.on("connect_error", (error) => {
          setConnected(false);
          setStarting(false);
          setErrorMessage(error.message || "Socket connection failed.");
          writeLine(`[socket] ${error.message || "connection failed"}`);
        });

        socket.on("terminal:started", (payload: StartedEvent) => {
          const activeSessionId = sessionIdRef.current;
          if (activeSessionId && payload.sessionId !== activeSessionId) return;
          setSessionId(payload.sessionId);
          sessionIdRef.current = payload.sessionId;
          setStarting(false);
          setErrorMessage(null);
          setCwd(payload.cwd);
          writeLine(`Connected to ${payload.shell} at ${payload.cwd}`);
        });

        socket.on("terminal:data", (payload: DataEvent) => {
          if (!terminalRef.current) return;
          const activeSessionId = sessionIdRef.current;
          if (activeSessionId && payload.sessionId !== activeSessionId) return;
          terminalRef.current.write(payload.data);
        });

        socket.on("terminal:exit", (payload: ExitEvent) => {
          const activeSessionId = sessionIdRef.current;
          if (activeSessionId && payload.sessionId !== activeSessionId) return;
          writeLine(
            `\r\n[process exited] code=${payload.code ?? "null"} signal=${payload.signal ?? "null"}`,
          );
          setStarting(false);
        });

        socket.on("terminal:error", (payload: ErrorEvent) => {
          const activeSessionId = sessionIdRef.current;
          if (payload.sessionId && activeSessionId && payload.sessionId !== activeSessionId) {
            return;
          }
          const message = payload.error || "Terminal error";
          setErrorMessage(message);
          setStarting(false);
          writeLine(`\r\n[terminal error] ${message}`);
        });
      } catch (error) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Failed to initialize socket connection.",
        );
      }
    };

    void connectSocket();

    return () => {
      mounted = false;
      const socket = socketRef.current;
      if (socket) {
        if (sessionIdRef.current) {
          socket.emit("terminal:stop", { sessionId: sessionIdRef.current });
        }
        socket.disconnect();
      }
      socketRef.current = null;
      setConnected(false);
    };
  }, [socketUrl, startTerminal, supabase, writeLine]);

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;
    const terminal = new Terminal({
      convertEol: true,
      disableStdin: false,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "monospace",
      theme: { background: "#1f2228" },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    terminal.write("Terminal initializing...\r\n");

    requestAnimationFrame(() => fitAddon.fit());

    const resizeObserver = new ResizeObserver(() => fitAddon.fit());
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!terminalRef.current) {
      return;
    }

    const onDataDispose = terminalRef.current.onData((data) => {
      if (!sessionId) return;
      socketRef.current?.emit("terminal:input", { sessionId, data });
    });

    return () => {
      onDataDispose.dispose();
    };
  }, [sessionId]);

  return (
    <div className="h-full flex flex-col bg-sidebar">
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2 text-xs">
        <select
          value={selectedShell}
          onChange={(event) => {
            const nextShell = event.target.value as TerminalShell;
            setSelectedShell(nextShell);
            if (connected) {
              startTerminal(nextShell);
            }
          }}
          className="rounded border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="powershell">PowerShell</option>
          <option value="cmd">Command Prompt</option>
          <option value="gitbash">Git Bash</option>
        </select>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          onClick={() => startTerminal(selectedShell)}
          disabled={!connected || starting}
        >
          <RefreshCw className="h-3 w-3" />
          Restart
        </Button>
        <div className="ml-auto truncate text-muted-foreground">
          {cwd ? cwd : connected ? "Connecting shell..." : "Socket disconnected"}
        </div>
      </div>
      {errorMessage && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-1 text-xs text-destructive">
          {errorMessage}
        </div>
      )}
      {!socketUrl && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-1 text-xs text-destructive">
          NEXT_PUBLIC_SOCKET_SERVER_URL is not configured.
        </div>
      )}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 p-3 [&_.xterm]:h-full! [&_.xterm-viewport]:h-full! [&_.xterm-screen]:h-full!"
      />
    </div>
  );
};
