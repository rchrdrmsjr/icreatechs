import "dotenv/config";

import fs from "fs";
import http from "http";
import path from "path";
import { randomUUID } from "crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { Server } from "socket.io";
import Redis, { type RedisOptions } from "ioredis";
import { createClient } from "@supabase/supabase-js";

const port = Number.parseInt(process.env.SOCKET_PORT ?? "3001", 10);
const corsOrigins = (process.env.SOCKET_CORS_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const redisConfig: RedisOptions = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number.parseInt(process.env.REDIS_PORT ?? "6379", 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
};

const server = http.createServer();
const io = new Server(server, {
  cors: {
    origin: corsOrigins.length > 0 ? corsOrigins : "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const redisSubscriber = new Redis(redisConfig);
redisSubscriber.on("error", (error) => {
  console.error("[socket] Redis subscriber error", error);
});
redisSubscriber.on("connect", () => {
  console.log("[socket] Redis subscriber connected");
});

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin =
  supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey, {
        auth: { persistSession: false },
      })
    : null;

const isDevelopment = process.env.NODE_ENV === "development";
if (!supabaseAdmin) {
  if (!isDevelopment) {
    throw new Error("Supabase admin client not configured");
  }
  console.warn(
    "[socket] Supabase admin client not configured. Auth checks will fail in development.",
  );
}

type TerminalShell = "powershell" | "cmd" | "gitbash";

type TerminalSession = {
  process: ChildProcessWithoutNullStreams;
  shell: TerminalShell;
  cwd: string;
};

const terminalSessions = new Map<string, TerminalSession>();

const resolveTerminalRoot = () => {
  const fromEnv = process.env.TERMINAL_PROJECT_ROOT;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return path.resolve(fromEnv);
  }
  return process.cwd();
};

const resolveShellCommand = (shell: TerminalShell) => {
  if (process.platform !== "win32") {
    if (shell === "powershell") {
      return { command: "pwsh", args: ["-NoLogo"] };
    }
    if (shell === "cmd") {
      return { command: "bash", args: [] };
    }
    return { command: "bash", args: ["--login"] };
  }

  if (shell === "powershell") {
    return { command: "powershell.exe", args: ["-NoLogo"] };
  }
  if (shell === "cmd") {
    return { command: process.env.ComSpec ?? "cmd.exe", args: [] };
  }

  const preferredGitBashPath =
    process.env.GIT_BASH_PATH ?? "C:\\Program Files\\Git\\bin\\bash.exe";
  if (fs.existsSync(preferredGitBashPath)) {
    return { command: preferredGitBashPath, args: ["--login", "-i"] };
  }
  return { command: "bash", args: ["--login", "-i"] };
};

const destroyTerminalSession = (sessionId: string) => {
  const session = terminalSessions.get(sessionId);
  if (!session) return;
  if (!session.process.killed) {
    session.process.kill();
  }
  terminalSessions.delete(sessionId);
};

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.accessToken as string | undefined;
  if (!token) {
    return next(new Error("Unauthorized"));
  }

  try {
    const { data, error } = await supabaseAdmin!.auth.getUser(token);
    if (error || !data?.user) {
      return next(new Error("Unauthorized"));
    }

    (socket.data as { user?: unknown }).user = data.user;
    return next();
  } catch (error) {
    console.error("[socket] Auth check failed", error);
    return next(new Error("Unauthorized"));
  }
});

io.on("connection", (socket) => {
  console.log("[socket] client connected", socket.id);
  const socketSessionIds = new Set<string>();

  socket.on("join", (payload: { conversationId?: string }) => {
    if (!payload?.conversationId) return;
    socket.join(payload.conversationId);
  });

  socket.on("leave", (payload: { conversationId?: string }) => {
    if (!payload?.conversationId) return;
    socket.leave(payload.conversationId);
  });

  socket.on(
    "terminal:start",
    (payload?: { shell?: TerminalShell; sessionId?: string }) => {
      const shell = payload?.shell ?? "powershell";
      const requestedSessionId = payload?.sessionId;
      const sessionId =
        typeof requestedSessionId === "string" && requestedSessionId.trim()
          ? requestedSessionId
          : randomUUID();

      if (!["powershell", "cmd", "gitbash"].includes(shell)) {
        socket.emit("terminal:error", {
          sessionId,
          error: `Unsupported shell: ${shell}`,
        });
        return;
      }

      const currentCwd = resolveTerminalRoot();
      const { command, args } = resolveShellCommand(shell);

      try {
        if (terminalSessions.has(sessionId)) {
          destroyTerminalSession(sessionId);
        }

        const child = spawn(command, args, {
          cwd: currentCwd,
          env: process.env,
          stdio: "pipe",
          windowsHide: true,
        });

        terminalSessions.set(sessionId, {
          process: child,
          shell,
          cwd: currentCwd,
        });
        socketSessionIds.add(sessionId);

        socket.emit("terminal:started", {
          sessionId,
          shell,
          cwd: currentCwd,
        });

        child.stdout.on("data", (chunk: Buffer | string) => {
          socket.emit("terminal:data", {
            sessionId,
            data: chunk.toString(),
          });
        });

        child.stderr.on("data", (chunk: Buffer | string) => {
          socket.emit("terminal:data", {
            sessionId,
            data: chunk.toString(),
          });
        });

        child.on("close", (code, signal) => {
          socket.emit("terminal:exit", {
            sessionId,
            code: typeof code === "number" ? code : null,
            signal: signal ?? null,
          });
          terminalSessions.delete(sessionId);
          socketSessionIds.delete(sessionId);
        });

        child.on("error", (error) => {
          socket.emit("terminal:error", {
            sessionId,
            error: error.message,
          });
          terminalSessions.delete(sessionId);
          socketSessionIds.delete(sessionId);
        });
      } catch (error) {
        socket.emit("terminal:error", {
          sessionId,
          error: error instanceof Error ? error.message : "Failed to start terminal",
        });
      }
    },
  );

  socket.on("terminal:input", (payload?: { sessionId?: string; data?: string }) => {
    const sessionId = payload?.sessionId;
    const data = payload?.data;
    if (!sessionId || typeof data !== "string" || !socketSessionIds.has(sessionId)) {
      return;
    }

    const session = terminalSessions.get(sessionId);
    if (!session) {
      return;
    }

    try {
      session.process.stdin.write(data);
    } catch (error) {
      socket.emit("terminal:error", {
        sessionId,
        error: error instanceof Error ? error.message : "Failed to write input",
      });
    }
  });

  socket.on("terminal:stop", (payload?: { sessionId?: string }) => {
    const sessionId = payload?.sessionId;
    if (!sessionId || !socketSessionIds.has(sessionId)) return;
    destroyTerminalSession(sessionId);
    socketSessionIds.delete(sessionId);
  });

  socket.on("disconnect", () => {
    for (const sessionId of socketSessionIds) {
      destroyTerminalSession(sessionId);
    }
    socketSessionIds.clear();
    console.log("[socket] client disconnected", socket.id);
  });
});

void redisSubscriber.psubscribe("stream:conversation:*");
redisSubscriber.on("pmessage", (_pattern, channel, message) => {
  let payload: unknown;
  try {
    payload = JSON.parse(message);
  } catch (error) {
    console.warn("[socket] Failed to parse stream payload", error);
    return;
  }

  if (!payload || typeof payload !== "object") {
    return;
  }

  const typedPayload = payload as Record<string, unknown>;
  const conversationId =
    typeof typedPayload.conversationId === "string"
      ? typedPayload.conversationId
      : channel.split(":")[2] || null;
  if (!conversationId) {
    return;
  }

  const eventType =
    typeof typedPayload.type === "string" ? typedPayload.type : "token";
  const eventName =
    eventType === "done"
      ? "message:done"
      : eventType === "error"
        ? "message:error"
        : "message:token";

  io.to(conversationId).emit(eventName, typedPayload);
});

server.listen(port, () => {
  console.log(`[socket] server listening on :${port}`);
});
