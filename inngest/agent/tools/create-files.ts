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
      "Create one or more new files in the project. If a file already exists, use updateFile instead.",
    inputSchema: zodSchema(inputSchema),
    execute: async ({ files }) => {
      const supabase = createAdminClient();
      const storage = supabase.storage.from("project-files");

      const results = await Promise.all(
        files.map(async (file) => {
          const parentInfo = await loadParentPath(
            supabase,
            projectId,
            normalizeParentId(file.parentId),
          );
          const resolvedParentId = normalizeParentId(file.parentId);
          const path = normalizePath(parentInfo?.path ?? null, file.name);

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
              parent_id: parentInfo?.id ?? null,
              path,
              content: null,
              size_bytes: computeSizeBytes(content),
              storage_path: storagePath,
            })
            .select("id, name, type, parent_id, path, storage_path")
            .single();

          if (error) {
            return { success: false, error: error.message, name: file.name, path };
          }

          return { success: true, id: created.id, name: created.name, path: created.path, file: created };
        }),
      );

      const created = results.filter(r => r.success).map(r => ({ name: r.name, id: r.id }));
      const failed = results.filter(r => !r.success).map(r => ({ name: r.name, error: r.error }));

      return {
        success: failed.length === 0,
        created,
        failed: failed.length > 0 ? failed : undefined,
        error: failed.length > 0 ? `${failed.length} file(s) failed to create` : undefined
      };
    },
  });
