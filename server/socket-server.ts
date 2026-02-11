import "dotenv/config";

import http from "http";
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

  socket.on("join", (payload: { conversationId?: string }) => {
    if (!payload?.conversationId) return;
    socket.join(payload.conversationId);
  });

  socket.on("leave", (payload: { conversationId?: string }) => {
    if (!payload?.conversationId) return;
    socket.leave(payload.conversationId);
  });

  socket.on("disconnect", () => {
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
