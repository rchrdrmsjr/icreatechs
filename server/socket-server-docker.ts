import "dotenv/config";

import http from "http";
import { Server } from "socket.io";
import Redis, { type RedisOptions } from "ioredis";
import { createClient } from "@supabase/supabase-js";
import {
    getOrCreateContainer,
    stopContainer,
    touchContainer,
    startIdleCleanup,
} from "./container-manager";
import { spawnPTYInContainer, type PTYSession } from "./pty-handler";

const port = Number.parseInt(process.env.DOCKER_SOCKET_PORT ?? "3002", 10);
const corsOrigins = (process.env.DOCKER_SOCKET_CORS_ORIGIN ?? "http://localhost:3000")
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

// Track PTY sessions
const ptySessions = new Map<string, PTYSession>();

// Start idle container cleanup
startIdleCleanup();

// Authentication middleware
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

        (socket.data as { user?: { id: string } }).user = { id: data.user.id };
        return next();
    } catch (error) {
        console.error("[socket] Auth check failed", error);
        return next(new Error("Unauthorized"));
    }
});

io.on("connection", (socket) => {
    console.log("[socket] client connected", socket.id);

    const userId = (socket.data as { user?: { id: string } }).user?.id;
    if (!userId) {
        socket.disconnect();
        return;
    }

    const socketSessionIds = new Set<string>();

    // Join conversation rooms (for AI messaging)
    socket.on("join", (payload: { conversationId?: string }) => {
        if (!payload?.conversationId) return;
        socket.join(payload.conversationId);
    });

    socket.on("leave", (payload: { conversationId?: string }) => {
        if (!payload?.conversationId) return;
        socket.leave(payload.conversationId);
    });

    // Terminal: Start a new session
    socket.on(
        "terminal:start",
        async (payload?: { projectId?: string; sessionId?: string }) => {
            const projectId = payload?.projectId;
            const requestedSessionId = payload?.sessionId;

            if (!projectId) {
                socket.emit("terminal:error", {
                    sessionId: requestedSessionId,
                    error: "Project ID is required",
                });
                return;
            }

            const sessionId =
                typeof requestedSessionId === "string" && requestedSessionId.trim()
                    ? requestedSessionId
                    : `terminal-${Date.now()}`;

            try {
                // Get or create persistent container for this project
                const containerSession = await getOrCreateContainer({
                    projectId,
                    userId,
                });

                if (containerSession.status === "error") {
                    socket.emit("terminal:error", {
                        sessionId,
                        error: "Failed to start container",
                    });
                    return;
                }

                // Spawn PTY shell inside the container
                const ptySession = await spawnPTYInContainer({
                    containerId: containerSession.containerId,
                    sessionId,
                    shell: "/bin/bash",
                    cwd: "/workspace",
                    env: {
                        TERM: "xterm-256color",
                        HOME: "/workspace",
                        USER: "developer",
                    },
                });

                ptySessions.set(sessionId, ptySession);
                socketSessionIds.add(sessionId);

                // Touch container to update last accessed time
                touchContainer({ projectId, userId });

                // Send started event
                socket.emit("terminal:started", {
                    sessionId,
                    shell: "bash",
                    cwd: "/workspace",
                    containerId: containerSession.containerId,
                });

                // Stream data from PTY to client
                ptySession.onData((data) => {
                    socket.emit("terminal:data", {
                        sessionId,
                        data,
                    });
                });

                // Handle PTY exit
                ptySession.onExit((code, signal) => {
                    socket.emit("terminal:exit", {
                        sessionId,
                        code,
                        signal,
                    });
                    ptySessions.delete(sessionId);
                    socketSessionIds.delete(sessionId);
                });
            } catch (error) {
                console.error("[terminal] Failed to start:", error);
                socket.emit("terminal:error", {
                    sessionId,
                    error: error instanceof Error ? error.message : "Failed to start terminal",
                });
            }
        },
    );

    // Terminal: Send input to PTY
    socket.on("terminal:input", (payload?: { sessionId?: string; data?: string }) => {
        const sessionId = payload?.sessionId;
        const data = payload?.data;

        if (!sessionId || typeof data !== "string" || !socketSessionIds.has(sessionId)) {
            return;
        }

        const ptySession = ptySessions.get(sessionId);
        if (!ptySession) {
            return;
        }

        try {
            ptySession.write(data);
        } catch (error) {
            console.error("[terminal] Input write error:", error);
            socket.emit("terminal:error", {
                sessionId,
                error: error instanceof Error ? error.message : "Failed to write input",
            });
        }
    });

    // Terminal: Resize PTY
    socket.on(
        "terminal:resize",
        (payload?: { sessionId?: string; cols?: number; rows?: number }) => {
            const sessionId = payload?.sessionId;
            const cols = payload?.cols;
            const rows = payload?.rows;

            if (
                !sessionId ||
                typeof cols !== "number" ||
                typeof rows !== "number" ||
                !socketSessionIds.has(sessionId)
            ) {
                return;
            }

            const ptySession = ptySessions.get(sessionId);
            if (!ptySession) {
                return;
            }

            try {
                ptySession.resize(cols, rows);
            } catch (error) {
                console.error("[terminal] Resize error:", error);
            }
        },
    );

    // Terminal: Stop session
    socket.on("terminal:stop", (payload?: { sessionId?: string }) => {
        const sessionId = payload?.sessionId;
        if (!sessionId || !socketSessionIds.has(sessionId)) return;

        const ptySession = ptySessions.get(sessionId);
        if (ptySession) {
            ptySession.kill();
            ptySessions.delete(sessionId);
        }
        socketSessionIds.delete(sessionId);
    });

    // Handle disconnect
    socket.on("disconnect", () => {
        // Kill all PTY sessions for this socket
        for (const sessionId of socketSessionIds) {
            const ptySession = ptySessions.get(sessionId);
            if (ptySession) {
                ptySession.kill();
                ptySessions.delete(sessionId);
            }
        }
        socketSessionIds.clear();
        console.log("[socket] client disconnected", socket.id);
    });
});

// Redis pubsub for AI message streaming
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
