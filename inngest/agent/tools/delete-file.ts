import { tool, zodSchema } from "ai";
import { z } from "zod";

import { createAdminClient } from "@/utils/supabase/admin";

interface DeleteFileToolOptions {
  projectId: string;
}

const inputSchema = z.object({
  fileId: z.string().min(1),
});

export const createDeleteFileTool = ({ projectId }: DeleteFileToolOptions) =>
  tool({
    description: "Delete a file or folder. Folders are deleted recursively.",
    inputSchema: zodSchema(inputSchema),
    execute: async ({ fileId }) => {
      const supabase = createAdminClient();

      const { data: file, error: fileError } = await supabase
        .from("files")
        .select("id, type, path, storage_path")
        .eq("id", fileId)
        .eq("project_id", projectId)
        .eq("is_deleted", false)
        .single();

      if (fileError || !file) {
        return { error: "File not found" };
      }

      const { data: updated, error: updateError } = await supabase
        .from("files")
        .update({ is_deleted: true, updated_at: new Date().toISOString() })
        .eq("id", fileId)
        .eq("project_id", projectId)
        .eq("is_deleted", false)
        .select("id");

      if (updateError || !updated || updated.length === 0) {
        console.warn("[deleteFile] failed to mark file deleted", {
          fileId,
          projectId,
          error: updateError?.message,
        });
        return {
          error: updateError?.message ?? "Failed to delete file",
        };
      }

      const storageClient = supabase.storage.from("project-files");

      if (file.storage_path) {
        try {
          const { error: storageError } = await storageClient.remove([
            file.storage_path,
          ]);
          if (storageError) {
            console.error("[deleteFile] failed to remove storage file", {
              fileId,
              projectId,
              path: file.storage_path,
              error: storageError.message,
            });
            await supabase
              .from("files")
              .update({
                is_deleted: false,
                updated_at: new Date().toISOString(),
              })
              .eq("id", fileId)
              .eq("project_id", projectId);
            return { error: storageError.message };
          }
        } catch (storageError) {
          console.error("[deleteFile] storage remove threw", {
            fileId,
            projectId,
            path: file.storage_path,
            error:
              storageError instanceof Error
                ? storageError.message
                : "Unknown error",
          });
          await supabase
            .from("files")
            .update({
              is_deleted: false,
              updated_at: new Date().toISOString(),
            })
            .eq("id", fileId)
            .eq("project_id", projectId);
          return {
            error:
              storageError instanceof Error
                ? storageError.message
                : "Failed to remove file from storage",
          };
        }
      }

      if (file.type === "folder") {
        const { data: descendants, error: descendantsError } = await supabase
          .from("files")
          .select("id, storage_path")
          .eq("project_id", projectId)
          .like("path", `${file.path}/%`)
          .eq("is_deleted", false);

        if (descendantsError) {
          console.error("[deleteFile] failed to load descendants", {
            fileId,
            projectId,
            error: descendantsError.message,
          });
          return { error: descendantsError.message };
        }

        const { error: descendantsUpdateError } = await supabase
          .from("files")
          .update({ is_deleted: true, updated_at: new Date().toISOString() })
          .eq("project_id", projectId)
          .like("path", `${file.path}/%`);

        if (descendantsUpdateError) {
          console.error("[deleteFile] failed to mark descendants deleted", {
            fileId,
            projectId,
            error: descendantsUpdateError.message,
          });
          return { error: descendantsUpdateError.message };
        }

        const storagePaths = (descendants ?? [])
          .map((desc) => desc.storage_path)
          .filter((path): path is string => Boolean(path));

        if (storagePaths.length > 0) {
          try {
            const { error: storageError } = await storageClient.remove(
              storagePaths,
            );
            if (storageError) {
              console.error("[deleteFile] failed to remove descendant storage", {
                fileId,
                projectId,
                error: storageError.message,
              });
              return { error: storageError.message };
            }
          } catch (storageError) {
            console.error("[deleteFile] descendant storage remove threw", {
              fileId,
              projectId,
              error:
                storageError instanceof Error
                  ? storageError.message
                  : "Unknown error",
            });
            return {
              error:
                storageError instanceof Error
                  ? storageError.message
                  : "Failed to remove descendant files from storage",
            };
          }
        }
      }

      return { deletedPath: file.path };
    },
  });
