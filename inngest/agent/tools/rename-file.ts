import { tool, zodSchema } from "ai";
import { z } from "zod";

import { createAdminClient } from "@/utils/supabase/admin";
import { loadParentPath, normalizeParentId, normalizePath } from "./helpers";

interface RenameFileToolOptions {
  projectId: string;
}

const inputSchema = z.object({
  fileId: z.string().min(1),
  name: z.string().optional(),
  parentId: z.string().nullable().optional(),
});

export const createRenameFileTool = ({ projectId }: RenameFileToolOptions) =>
  tool({
    description: "Rename or move a file or folder.",
    inputSchema: zodSchema(inputSchema),
    execute: async ({ fileId, name, parentId }) => {
      const supabase = createAdminClient();

      if (name === undefined && parentId === undefined) {
        return { error: "name or parentId is required" };
      }

      const { data: file, error: fileError } = await supabase
        .from("files")
        .select("id, name, type, parent_id, path, storage_path")
        .eq("id", fileId)
        .eq("project_id", projectId)
        .eq("is_deleted", false)
        .maybeSingle();

      if (fileError || !file) {
        return { error: "File not found" };
      }

      const originalName = file.name;
      const trimmedName = name ? name.trim() : file.name;
      if (name !== undefined && !trimmedName) {
        return { error: "name cannot be empty" };
      }

      const targetParentId = normalizeParentId(
        parentId === undefined ? file.parent_id : parentId,
      );

      if (targetParentId === file.id) {
        return { error: "Cannot move a folder into itself" };
      }

      const parentPath = await loadParentPath(
        supabase,
        projectId,
        targetParentId ?? null,
      );

      const newPath = normalizePath(parentPath, trimmedName);
      const oldPath = file.path;

      if (
        file.type === "folder" &&
        parentPath &&
        parentPath.startsWith(`${oldPath}/`)
      ) {
        return { error: "Cannot move a folder into its descendant" };
      }

      const { data: conflict } = await supabase
        .from("files")
        .select("id")
        .eq("project_id", projectId)
        .eq("path", newPath)
        .eq("is_deleted", false)
        .neq("id", fileId)
        .maybeSingle();

      if (conflict) {
        return { error: "A file or folder with that name already exists" };
      }

      const { data: updatedFile, error: updateError } = await supabase
        .from("files")
        .update({
          name: trimmedName,
          parent_id: targetParentId ?? null,
          path: newPath,
          updated_at: new Date().toISOString(),
        })
        .eq("id", fileId)
        .select("id, name, type, parent_id, path, storage_path")
        .maybeSingle();

      if (updateError) {
        return { error: updateError.message };
      }

      const resolvedUpdatedFile =
        updatedFile ?? {
          ...file,
          name: trimmedName,
          parent_id: targetParentId ?? null,
          path: newPath,
        };

      const storageClient = supabase.storage.from("project-files");

      if (file.storage_path && newPath !== oldPath) {
        const oldStoragePath = file.storage_path;
        const newStoragePath = `${projectId}/${newPath}`;

        const { error: moveError } = await storageClient.move(
          oldStoragePath,
          newStoragePath,
        );

        if (moveError) {
          await supabase
            .from("files")
            .update({
              name: originalName,
              path: oldPath,
              parent_id: file.parent_id,
            })
            .eq("id", fileId);

          return { error: moveError.message };
        }

        await supabase
          .from("files")
          .update({ storage_path: newStoragePath })
          .eq("id", fileId);

        resolvedUpdatedFile.storage_path = newStoragePath;
      }

      if (file.type === "folder" && newPath !== oldPath) {
        const { data: descendants, error: descendantsError } = await supabase
          .from("files")
          .select("id, path, storage_path")
          .eq("project_id", projectId)
          .like("path", `${oldPath}/%`)
          .eq("is_deleted", false);

        if (descendantsError) {
          return { error: descendantsError.message };
        }

        if (descendants && descendants.length > 0) {
          for (const child of descendants) {
            const childNewPath = `${newPath}${child.path.slice(oldPath.length)}`;
            const updates: Record<string, any> = {
              path: childNewPath,
              updated_at: new Date().toISOString(),
            };

            if (child.storage_path) {
              const childNewStoragePath = `${projectId}/${childNewPath}`;
              const { error: moveError } = await storageClient.move(
                child.storage_path,
                childNewStoragePath,
              );

              if (moveError) {
                console.error("[renameFile] failed to move descendant storage", {
                  childId: child.id,
                  from: child.storage_path,
                  to: childNewStoragePath,
                  error: moveError.message,
                });
                return { error: moveError.message };
              }

              updates.storage_path = childNewStoragePath;
            }

            const { error: updateChildError } = await supabase
              .from("files")
              .update(updates)
              .eq("id", child.id);

            if (updateChildError) {
              return { error: updateChildError.message };
            }
          }
        }
      }

      return { file: resolvedUpdatedFile };
    },
  });
