import Docker from "dockerode";
import { randomUUID } from "crypto";
import { syncFilesToContainer } from "./file-sync";

const docker = new Docker({
    socketPath: process.platform === "win32"
        ? "//./pipe/docker_engine"
        : "/var/run/docker.sock",
});

export type ContainerSession = {
    containerId: string;
    containerName: string;
    projectId: string;
    userId: string;
    volumeName: string;
    createdAt: Date;
    lastAccessedAt: Date;
    status: "starting" | "running" | "stopped" | "error";
};

// Track active container sessions
const containerSessions = new Map<string, ContainerSession>();

/**
 * Get or create a persistent container for a project
 */
export async function getOrCreateContainer(params: {
    projectId: string;
    userId: string;
}): Promise<ContainerSession> {
    const { projectId, userId } = params;
    const sessionKey = `${userId}-${projectId}`;

    // Check if container already exists in session cache
    const existingSession = containerSessions.get(sessionKey);
    if (existingSession) {
        // Try to start the container if it's stopped
        if (existingSession.status === "stopped") {
            try {
                const container = docker.getContainer(existingSession.containerId);
                await container.start();
                existingSession.status = "running";
                existingSession.lastAccessedAt = new Date();
            } catch (error) {
                console.error("[container] Failed to restart container:", error);
                existingSession.status = "error";
            }
        }
        return existingSession;
    }

    // Create new persistent container (or reuse if exists)
    const containerName = `workspace-${userId}-${projectId}`;
    const volumeName = `workspace-vol-${userId}-${projectId}`;

    try {
        // Check if container already exists by name
        const containers = await docker.listContainers({ all: true });
        const existing = containers.find((c) =>
            c.Names.includes(`/${containerName}`)
        );

        if (existing) {
            console.log(`[container] Found existing container ${containerName}`);
            const container = docker.getContainer(existing.Id);

            // Start if stopped
            if (existing.State !== "running") {
                await container.start();
            }

            const session: ContainerSession = {
                containerId: existing.Id,
                containerName,
                projectId,
                userId,
                volumeName,
                createdAt: new Date(),
                lastAccessedAt: new Date(),
                status: "running",
            };

            containerSessions.set(sessionKey, session);

            // Sync files for existing container
            syncFilesToContainer({ projectId, containerId: existing.Id })
                .then(({ synced, errors }) => {
                    console.log(`[container] File sync complete: ${synced} files synced`);
                    if (errors.length > 0) {
                        console.error(`[container] Sync errors:`, errors);
                    }
                })
                .catch((err) => {
                    console.error(`[container] File sync failed:`, err);
                });

            return session;
        }

        // Create Docker volume if it doesn't exist
        await ensureVolumeExists(volumeName);

        // Create container with resource limits
        const container = await docker.createContainer({
            name: containerName,
            Image: process.env.WORKSPACE_IMAGE || "icreatechs/workspace:latest",

            // Resource limits per requirements
            HostConfig: {
                Memory: 1024 * 1024 * 1024, // 1GB RAM
                MemorySwap: 1024 * 1024 * 1024, // No swap
                NanoCpus: 1_000_000_000, // 1 CPU core

                // Mount volume at /workspace
                Binds: [`${volumeName}:/workspace`],

                // Note: Disk quota via StorageOpt requires Linux with xfs+pquota
                // On Windows/Mac Docker Desktop, use Docker Desktop settings for disk limits

                // Security settings
                NetworkMode: "bridge", // Outbound internet access
                Privileged: false,
                ReadonlyRootfs: false,

                // Prevent fork bombs
                PidsLimit: 100,
            },

            // Keep container alive
            Tty: true,
            OpenStdin: true,

            // Run as non-root user
            User: "developer",

            // Environment
            Env: [
                "TERM=xterm-256color",
                "HOME=/workspace",
            ],

            // Working directory
            WorkingDir: "/workspace",

            // Use bash as default shell
            Cmd: ["/bin/bash"],

            // Labels for tracking
            Labels: {
                "app": "icreatechs",
                "projectId": projectId,
                "userId": userId,
            },
        });

        // Start the container
        await container.start();

        const session: ContainerSession = {
            containerId: container.id,
            containerName,
            projectId,
            userId,
            volumeName,
            createdAt: new Date(),
            lastAccessedAt: new Date(),
            status: "running",
        };

        containerSessions.set(sessionKey, session);

        console.log(`[container] Created container ${containerName} with volume ${volumeName}`);

        // Sync project files from Supabase to container
        syncFilesToContainer({ projectId, containerId: container.id })
            .then(({ synced, errors }) => {
                console.log(`[container] File sync complete: ${synced} files synced`);
                if (errors.length > 0) {
                    console.error(`[container] Sync errors:`, errors);
                }
            })
            .catch((err) => {
                console.error(`[container] File sync failed:`, err);
            });

        return session;
    } catch (error) {
        console.error("[container] Failed to create container:", error);
        throw new Error(`Failed to create workspace container: ${error instanceof Error ? error.message : "unknown error"}`);
    }
}

/**
 * Ensure Docker volume exists, create if needed
 */
async function ensureVolumeExists(volumeName: string): Promise<void> {
    try {
        const volume = docker.getVolume(volumeName);
        await volume.inspect();
        console.log(`[container] Volume ${volumeName} already exists`);
    } catch (error) {
        // Volume doesn't exist, create it
        await docker.createVolume({
            Name: volumeName,
            Labels: {
                "app": "icreatechs",
            },
        });
        console.log(`[container] Created volume ${volumeName}`);
    }
}

/**
 * Stop a container (but keep it for restart)
 */
export async function stopContainer(params: {
    projectId: string;
    userId: string;
}): Promise<void> {
    const { projectId, userId } = params;
    const sessionKey = `${userId}-${projectId}`;

    const session = containerSessions.get(sessionKey);
    if (!session) {
        return;
    }

    try {
        const container = docker.getContainer(session.containerId);
        await container.stop();
        session.status = "stopped";
        console.log(`[container] Stopped container ${session.containerName}`);
    } catch (error) {
        console.error("[container] Failed to stop container:", error);
    }
}

/**
 * Execute a command in the container
 */
export async function execInContainer(params: {
    containerId: string;
    command: string[];
}): Promise<any> {
    const { containerId, command } = params;

    const container = docker.getContainer(containerId);

    const exec = await container.exec({
        Cmd: command,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
    });

    return exec;
}

/**
 * Get container stats (CPU, memory usage)
 */
export async function getContainerStats(containerId: string): Promise<any> {
    const container = docker.getContainer(containerId);
    const stats = await container.stats({ stream: false });
    return stats;
}

/**
 * Cleanup idle containers (stop after 30min inactivity)
 */
export function startIdleCleanup() {
    setInterval(() => {
        const now = new Date();
        const idleTimeoutMs = 30 * 60 * 1000; // 30 minutes

        for (const [sessionKey, session] of containerSessions.entries()) {
            const idleTimeMs = now.getTime() - session.lastAccessedAt.getTime();

            if (idleTimeMs > idleTimeoutMs && session.status === "running") {
                console.log(`[container] Stopping idle container ${session.containerName}`);
                stopContainer({ projectId: session.projectId, userId: session.userId }).catch(
                    console.error
                );
            }
        }
    }, 5 * 60 * 1000); // Check every 5 minutes
}

/**
 * Update last accessed time (keep alive)
 */
export function touchContainer(params: { projectId: string; userId: string }) {
    const { projectId, userId } = params;
    const sessionKey = `${userId}-${projectId}`;

    const session = containerSessions.get(sessionKey);
    if (session) {
        session.lastAccessedAt = new Date();
    }
}
