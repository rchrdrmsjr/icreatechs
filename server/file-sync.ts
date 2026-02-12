import Docker from "dockerode";
import { createClient } from "@supabase/supabase-js";

const docker = new Docker({
    socketPath: process.platform === "win32"
        ? "//./pipe/docker_engine"
        : "/var/run/docker.sock",
});

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

export type SyncedFile = {
    id: string;
    path: string;
    name: string;
    type: "file" | "folder";
    content: string | null;
    parent_id: string | null;
};

/**
 * Sync all project files from Supabase → Docker volume
 * Called when container starts
 */
export async function syncFilesToContainer(params: {
    projectId: string;
    containerId: string;
}): Promise<{ synced: number; errors: string[] }> {
    const { projectId, containerId } = params;
    const errors: string[] = [];
    let synced = 0;

    try {
        console.log(`[file-sync] Syncing files for project ${projectId} to container ${containerId}`);

        // Fetch all non-deleted files from Supabase
        const { data: files, error } = await supabase
            .from("files")
            .select("id, path, name, type, content, parent_id, storage_path")
            .eq("project_id", projectId)
            .eq("is_deleted", false)
            .order("path", { ascending: true });

        if (error) {
            throw new Error(`Failed to fetch files: ${error.message}`);
        }

        if (!files || files.length === 0) {
            console.log(`[file-sync] No files to sync for project ${projectId}`);
            return { synced: 0, errors: [] };
        }

        console.log(`[file-sync] Found ${files.length} files to sync`);

        const container = docker.getContainer(containerId);

        // Create folders first, then files
        const folders = files.filter((f) => f.type === "folder");
        const regularFiles = files.filter((f) => f.type === "file");

        // Create folder structure
        for (const folder of folders) {
            try {
                const folderPath = `/workspace/${folder.path}`;
                await execInContainer(container, ["mkdir", "-p", folderPath]);
                synced++;
            } catch (err) {
                const msg = `Failed to create folder ${folder.path}: ${err instanceof Error ? err.message : "unknown"}`;
                console.error(`[file-sync] ${msg}`);
                errors.push(msg);
            }
        }

        // Create files
        for (const file of regularFiles) {
            try {
                const filePath = `/workspace/${file.path}`;
                let content = file.content || "";

                // If content is null but storage_path exists, fetch from Supabase Storage
                if (!content && file.storage_path) {
                    const { data: storageData, error: storageError } = await supabase.storage
                        .from("project-files")
                        .download(file.storage_path);

                    if (!storageError && storageData) {
                        content = await storageData.text();
                    }
                }

                // Create parent directory if needed
                const dirPath = filePath.substring(0, filePath.lastIndexOf("/"));
                if (dirPath !== "/workspace") {
                    await execInContainer(container, ["mkdir", "-p", dirPath]);
                }

                // Write file content
                // Use echo with heredoc for reliable multiline content
                const base64Content = Buffer.from(content).toString("base64");
                await execInContainer(container, [
                    "sh",
                    "-c",
                    `echo "${base64Content}" | base64 -d > "${filePath}"`,
                ]);

                // Set ownership to developer user
                await execInContainer(container, ["chown", "developer:developer", filePath]);

                synced++;
            } catch (err) {
                const msg = `Failed to sync file ${file.path}: ${err instanceof Error ? err.message : "unknown"}`;
                console.error(`[file-sync] ${msg}`);
                errors.push(msg);
            }
        }

        console.log(`[file-sync] Synced ${synced} items (${errors.length} errors)`);
        return { synced, errors };
    } catch (err) {
        const msg = `File sync failed: ${err instanceof Error ? err.message : "unknown"}`;
        console.error(`[file-sync] ${msg}`);
        errors.push(msg);
        return { synced, errors };
    }
}

/**
 * Sync a single file from Docker → Supabase
 * Called when file changes in container
 */
export async function syncFileFromContainer(params: {
    projectId: string;
    filepath: string;
    content: string;
    userId: string;
}): Promise<{ success: boolean; error?: string }> {
    const { projectId, filepath, content, userId } = params;

    try {
        console.log(`[file-sync] Syncing file ${filepath} from container to Supabase`);

        // Check if file exists
        const { data: existing, error: fetchError } = await supabase
            .from("files")
            .select("id, storage_path")
            .eq("project_id", projectId)
            .eq("path", filepath)
            .eq("is_deleted", false)
            .single();

        if (fetchError && fetchError.code !== "PGRST116") {
            throw new Error(`Failed to check existing file: ${fetchError.message}`);
        }

        const now = new Date().toISOString();

        if (existing) {
            // Update existing file
            const { error: updateError } = await supabase
                .from("files")
                .update({
                    content: content,
                    size_bytes: Buffer.from(content).length,
                    updated_by: userId,
                    updated_at: now,
                })
                .eq("id", existing.id);

            if (updateError) {
                throw new Error(`Failed to update file: ${updateError.message}`);
            }

            console.log(`[file-sync] Updated file ${filepath} in Supabase`);
        } else {
            // Create new file
            const fileName = filepath.split("/").pop() || filepath;
            const { error: insertError } = await supabase.from("files").insert({
                project_id: projectId,
                path: filepath,
                name: fileName,
                type: "file",
                content: content,
                size_bytes: Buffer.from(content).length,
                created_by: userId,
                updated_by: userId,
                created_at: now,
                updated_at: now,
            });

            if (insertError) {
                throw new Error(`Failed to create file: ${insertError.message}`);
            }

            console.log(`[file-sync] Created file ${filepath} in Supabase`);
        }

        return { success: true };
    } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        console.error(`[file-sync] Failed to sync file from container: ${msg}`);
        return { success: false, error: msg };
    }
}

/**
 * Helper: Execute command in Docker container
 */
async function execInContainer(
    container: Docker.Container,
    cmd: string[]
): Promise<string> {
    const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true,
    });

    return new Promise((resolve, reject) => {
        exec.start({ Detach: false }, (err, stream) => {
            if (err) {
                reject(err);
                return;
            }

            if (!stream) {
                reject(new Error("No stream from exec"));
                return;
            }

            let output = "";
            stream.on("data", (chunk: Buffer) => {
                output += chunk.toString();
            });

            stream.on("end", () => {
                resolve(output);
            });

            stream.on("error", (err) => {
                reject(err);
            });
        });
    });
}
