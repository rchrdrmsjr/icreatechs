import { tool, zodSchema } from "ai";
import { z } from "zod";

import { createAdminClient } from "@/utils/supabase/admin";
import {
  computeSizeBytes,
  findFileByPath,
  loadParentPath,
  normalizeParentId,
  normalizePath,
} from "./helpers";

interface CreateFilesToolOptions {
  projectId: string;
}

const fileSchema = z.object({
  name: z.string().min(1),
  parentId: z.string().nullable().optional(),
  content: z.string().optional(),
});

const inputSchema = z.object({
  files: z.array(fileSchema).min(1),
});

export const createCreateFilesTool = ({ projectId }: CreateFilesToolOptions) =>
  tool({
    description:
      "Create one or more files in the project. Skips files that already exist.",
    inputSchema: zodSchema(inputSchema),
    execute: async ({ files }) => {
      const supabase = createAdminClient();
      const storage = supabase.storage.from("project-files");

      const results = await Promise.all(
        files.map(async (file) => {
          const parentPath = await loadParentPath(
            supabase,
            projectId,
            normalizeParentId(file.parentId),
          );
          const resolvedParentId = normalizeParentId(file.parentId);
          const path = normalizePath(parentPath, file.name);

          const existing = await findFileByPath(supabase, projectId, path);
          if (existing) {
            return { status: "exists", file: existing };
          }

          const content = file.content ?? "";
          const storagePath = `${projectId}/${path}`;
          const fileBlob = new Blob([content], { type: "text/plain" });

          const { error: uploadError } = await storage.upload(
            storagePath,
            fileBlob,
            {
              contentType: "text/plain",
              upsert: true,
            },
          );

          if (uploadError) {
            return { error: uploadError.message, path };
          }

          const { data: created, error } = await supabase
            .from("files")
            .insert({
              project_id: projectId,
              name: file.name.trim(),
              type: "file",
              parent_id: resolvedParentId,
              path,
              content: null,
              size_bytes: computeSizeBytes(content),
              storage_path: storagePath,
            })
            .select("id, name, type, parent_id, path, storage_path")
            .single();

          if (error) {
            return { error: error.message, path };
          }

          return { status: "created", file: created };
        }),
      );

      return { results };
    },
  });
