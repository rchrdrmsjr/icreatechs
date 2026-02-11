import { tool, zodSchema } from "ai";
import { z } from "zod";

import { createAdminClient } from "@/utils/supabase/admin";

interface DeleteRecursiveToolOptions {
  projectId: string;
}

const inputSchema = z.object({
  fileId: z.string().min(1),
});

export const createDeleteRecursiveTool = ({
  projectId,
}: DeleteRecursiveToolOptions) =>
  tool({
    description: "Recursively delete a folder and all descendants.",
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
        console.warn("[deleteRecursive] failed to mark file deleted", {
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
        const { error: removeError } = await storageClient.remove([
          file.storage_path,
        ]);
        if (removeError) {
          console.warn("[deleteRecursive] failed to remove storage file", {
            fileId,
            projectId,
            storagePath: file.storage_path,
            error: removeError.message,
          });
          return {
            error: removeError.message,
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
          console.warn("[deleteRecursive] failed to load descendants", {
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
          console.warn("[deleteRecursive] failed to mark descendants deleted", {
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
          const { error: descendantsRemoveError } =
            await storageClient.remove(storagePaths);
          if (descendantsRemoveError) {
            console.warn("[deleteRecursive] failed to remove descendant storage", {
              fileId,
              projectId,
              error: descendantsRemoveError.message,
            });
            return { error: descendantsRemoveError.message };
          }
        }
      }

      return { deletedPath: file.path };
    },
  });
