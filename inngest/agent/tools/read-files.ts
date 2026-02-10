import { tool, zodSchema } from "ai";
import { z } from "zod";

import { createAdminClient } from "@/utils/supabase/admin";

interface ReadFilesToolOptions {
  projectId: string;
}

const inputSchema = z
  .object({
    fileIds: z.array(z.string()).optional(),
    paths: z.array(z.string()).optional(),
  })
  .refine((value) => (value.fileIds?.length ?? 0) > 0 || (value.paths?.length ?? 0) > 0, {
    message: "fileIds or paths is required",
  });

export const createReadFilesTool = ({ projectId }: ReadFilesToolOptions) =>
  tool({
    description: "Read one or more files by ID or path and return their contents.",
    inputSchema: zodSchema(inputSchema),
    execute: async ({ fileIds, paths }) => {
      const supabase = createAdminClient();

      let query = supabase
        .from("files")
        .select("id, name, path, type, content, storage_path")
        .eq("project_id", projectId)
        .eq("is_deleted", false);

      if (fileIds && fileIds.length > 0) {
        query = query.in("id", fileIds);
      } else if (paths && paths.length > 0) {
        query = query.in("path", paths);
      } else {
        return { files: [] };
      }

      const { data, error } = await query;

      if (error) {
        return { error: error.message, files: [] };
      }

      const storage = supabase.storage.from("project-files");

      const files = await Promise.all(
        (data ?? []).map(async (file) => {
          if (file.type !== "file") {
            return { ...file, content: null, error: "Not a file" };
          }

          if (file.content !== null && file.content !== undefined) {
            return { ...file, content: file.content };
          }

          if (file.storage_path) {
            const { data: download, error: downloadError } = await storage.download(
              file.storage_path,
            );

            if (downloadError || !download) {
              return {
                ...file,
                content: null,
                error: downloadError?.message ?? "Unable to download file",
              };
            }

            return { ...file, content: await download.text() };
          }

          return { ...file, content: "" };
        }),
      );

      return { files };
    },
  });
