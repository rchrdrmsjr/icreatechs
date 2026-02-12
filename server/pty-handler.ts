import * as pty from "node-pty";
import Docker from "dockerode";

export type PTYSession = {
    pty: pty.IPty;
    sessionId: string;
    containerId: string;
    onData: (callback: (data: string) => void) => void;
    onExit: (callback: (code: number | null, signal: string | null) => void) => void;
    write: (data: string) => void;
    resize: (cols: number, rows: number) => void;
    kill: () => void;
};

/**
 * Spawn a PTY shell inside a Docker container
 */
export async function spawnPTYInContainer(params: {
    containerId: string;
    sessionId: string;
    shell?: string;
    cwd?: string;
    env?: Record<string, string>;
}): Promise<PTYSession> {
    const { containerId, sessionId, shell = "/bin/bash", cwd = "/workspace", env = {} } = params;

    const docker = new Docker({
        socketPath: process.platform === "win32"
            ? "//./pipe/docker_engine"
            : "/var/run/docker.sock",
    });

    const container = docker.getContainer(containerId);

    // Create exec instance inside container
    const exec = await container.exec({
        Cmd: [shell],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        WorkingDir: cwd,
        Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
        User: "developer", // Run as non-root user
    });

    // Start the exec
    const stream = await exec.start({
        hijack: true,
        stdin: true,
        Tty: true,
    });

    // Create pseudo PTY interface
    const dataCallbacks: Array<(data: string) => void> = [];
    const exitCallbacks: Array<(code: number | null, signal: string | null) => void> = [];

    // Handle data from container
    stream.on("data", (chunk: Buffer) => {
        const data = chunk.toString("utf-8");
        dataCallbacks.forEach((cb) => cb(data));
    });

    // Handle stream end
    stream.on("end", async () => {
        try {
            const inspect = await exec.inspect();
            const exitCode = inspect.ExitCode ?? null;
            exitCallbacks.forEach((cb) => cb(exitCode, null));
        } catch (error) {
            console.error("[pty] Failed to inspect exec:", error);
            exitCallbacks.forEach((cb) => cb(null, "UNKNOWN"));
        }
    });

    stream.on("error", (error: Error) => {
        console.error("[pty] Stream error:", error);
        exitCallbacks.forEach((cb) => cb(null, "ERROR"));
    });

    const session: PTYSession = {
        pty: stream as any, // Docker stream acts like PTY
        sessionId,
        containerId,

        onData: (callback) => {
            dataCallbacks.push(callback);
        },

        onExit: (callback) => {
            exitCallbacks.push(callback);
        },

        write: (data: string) => {
            try {
                stream.write(data);
            } catch (error) {
                console.error("[pty] Write error:", error);
            }
        },

        resize: (cols: number, rows: number) => {
            // Resize TTY in container
            exec.resize({ h: rows, w: cols }).catch((error) => {
                console.error("[pty] Resize error:", error);
            });
        },

        kill: () => {
            try {
                stream.end();
            } catch (error) {
                console.error("[pty] Kill error:", error);
            }
        },
    };

    return session;
}

/**
 * Alternative: Use node-pty locally (for testing without Docker)
 */
export function spawnLocalPTY(params: {
    sessionId: string;
    shell?: string;
    cwd?: string;
    env?: Record<string, string>;
}): PTYSession {
    const { sessionId, shell = "bash", cwd = process.cwd(), env = {} } = params;

    const ptyProcess = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: 80,
        rows: 30,
        cwd,
        env: { ...process.env, ...env },
    });

    const dataCallbacks: Array<(data: string) => void> = [];
    const exitCallbacks: Array<(code: number | null, signal: string | null) => void> = [];

    ptyProcess.onData((data) => {
        dataCallbacks.forEach((cb) => cb(data));
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
        exitCallbacks.forEach((cb) => cb(exitCode ?? null, signal ? String(signal) : null));
    });

    return {
        pty: ptyProcess,
        sessionId,
        containerId: "local",

        onData: (callback) => {
            dataCallbacks.push(callback);
        },

        onExit: (callback) => {
            exitCallbacks.push(callback);
        },

        write: (data: string) => {
            ptyProcess.write(data);
        },

        resize: (cols: number, rows: number) => {
            ptyProcess.resize(cols, rows);
        },

        kill: () => {
            ptyProcess.kill();
        },
    };
}
