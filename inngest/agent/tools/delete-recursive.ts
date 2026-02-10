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

      await supabase
        .from("files")
        .update({ is_deleted: true, updated_at: new Date().toISOString() })
        .eq("id", fileId);

      const storageClient = supabase.storage.from("project-files");

      if (file.storage_path) {
        await storageClient.remove([file.storage_path]);
      }

      if (file.type === "folder") {
        const { data: descendants } = await supabase
          .from("files")
          .select("id, storage_path")
          .eq("project_id", projectId)
          .like("path", `${file.path}/%`)
          .eq("is_deleted", false);

        await supabase
          .from("files")
          .update({ is_deleted: true, updated_at: new Date().toISOString() })
          .eq("project_id", projectId)
          .like("path", `${file.path}/%`);

        const storagePaths = (descendants ?? [])
          .map((desc) => desc.storage_path)
          .filter((path): path is string => Boolean(path));

        if (storagePaths.length > 0) {
          await storageClient.remove(storagePaths);
        }
      }

      return { deletedPath: file.path };
    },
  });
