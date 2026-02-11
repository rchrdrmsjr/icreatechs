import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import * as Sentry from "@sentry/nextjs";
import { cache } from "@/lib/redis";

export const dynamic = "force-dynamic";

const createStorageClient = () => createAdminClient();

const normalizePath = (parentPath: string | null, name: string) => {
  const trimmedName = name.trim();
  const basePath = parentPath ? parentPath.replace(/\/+$/g, "") : "";
  return basePath ? `${basePath}/${trimmedName}` : trimmedName;
};

async function requireProjectAccess(
  supabase: ReturnType<typeof createClient>,
  projectId: string,
  userId: string,
) {
  const { data: project, error } = await supabase
    .from("projects")
    .select(
      `
      id,
      workspaces!inner (
        workspace_members!inner (
          user_id
        )
      )
    `,
    )
    .eq("id", projectId)
    .eq("workspaces.workspace_members.user_id", userId)
    .limit(1)
    .maybeSingle();

  if (error || !project) {
    return { ok: false as const };
  }

  return { ok: true as const };
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  return Sentry.startSpan(
    {
      op: "http.server",
      name: "PATCH /api/projects/[id]/files/[fileId]",
    },
    async () => {
      try {
        const { id, fileId } = await params;
        const cookieStore = await cookies();
        const supabase = createClient(cookieStore);

        const {
          data: { user },
          error: authError,
        } = await supabase.auth.getUser();

        if (authError || !user) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const access = await requireProjectAccess(supabase, id, user.id);
        if (!access.ok) {
          return NextResponse.json(
            { error: "Project not found or access denied" },
            { status: 404 },
          );
        }

        const body = await request.json();
        const { name, parent_id } = body;

        if (name === undefined && parent_id === undefined) {
          return NextResponse.json(
            { error: "name or parent_id is required" },
            { status: 400 },
          );
        }

        if (name !== undefined && typeof name !== "string") {
          return NextResponse.json(
            { error: "name must be a string" },
            { status: 400 },
          );
        }

        if (
          parent_id !== undefined &&
          parent_id !== null &&
          typeof parent_id !== "string"
        ) {
          return NextResponse.json(
            { error: "parent_id must be a string or null" },
            { status: 400 },
          );
        }

        const { data: file, error: fileError } = await supabase
          .from("files")
          .select("id, name, type, parent_id, path, storage_path")
          .eq("id", fileId)
          .eq("project_id", id)
          .eq("is_deleted", false)
          .limit(1)
          .maybeSingle();

        if (fileError || !file) {
          return NextResponse.json(
            { error: "File not found" },
            { status: 404 },
          );
        }

        const trimmedName = name ? name.trim() : file.name;

        if (name !== undefined && !trimmedName) {
          return NextResponse.json(
            { error: "name cannot be empty" },
            { status: 400 },
          );
        }
        const targetParentId =
          parent_id === undefined ? file.parent_id : parent_id;

        if (targetParentId === file.id) {
          return NextResponse.json(
            { error: "Cannot move a folder into itself" },
            { status: 400 },
          );
        }

        let parentPath: string | null = null;
        if (targetParentId) {
          const { data: parent, error: parentError } = await supabase
            .from("files")
            .select("id, path, type")
            .eq("id", targetParentId)
            .eq("project_id", id)
            .limit(1)
            .maybeSingle();

          if (parentError || !parent || parent.type !== "folder") {
            return NextResponse.json(
              { error: "Parent folder not found" },
              { status: 404 },
            );
          }

          parentPath = parent.path;
        }

        const newPath = normalizePath(parentPath, trimmedName);
        const oldPath = file.path;

        if (
          file.type === "folder" &&
          parentPath &&
          parentPath.startsWith(`${oldPath}/`)
        ) {
          return NextResponse.json(
            { error: "Cannot move a folder into its descendant" },
            { status: 400 },
          );
        }

        const { data: conflict } = await supabase
          .from("files")
          .select("id")
          .eq("project_id", id)
          .eq("path", newPath)
          .eq("is_deleted", false)
          .neq("id", fileId)
          .maybeSingle();

        if (conflict) {
          return NextResponse.json(
            { error: "A file or folder with that name already exists" },
            { status: 409 },
          );
        }

        const { data: updatedFile, error: updateError } = await supabase
          .from("files")
          .update({
            name: trimmedName,
            parent_id: targetParentId,
            path: newPath,
            updated_by: user.id,
          })
          .eq("id", fileId)
          .select("id, name, type, parent_id, path, storage_path")
          .limit(1)
          .maybeSingle();

        if (updateError) {
          Sentry.captureException(updateError);
          return NextResponse.json(
            { error: updateError?.message || "Failed to rename" },
            { status: 500 },
          );
        }

        const resolvedUpdatedFile =
          updatedFile ??
          {
            ...file,
            name: trimmedName,
            parent_id: targetParentId,
            path: newPath,
          };

        // Move file in storage if it has storage_path and path changed
        if (file.storage_path && newPath !== oldPath) {
          const storageClient = createStorageClient();
          const oldStoragePath = file.storage_path;
          const newStoragePath = `${id}/${newPath}`;

          const { error: moveError } = await storageClient.storage
            .from("project-files")
            .move(oldStoragePath, newStoragePath);

          if (moveError) {
            Sentry.captureException(moveError);
            // Rollback database change
            await supabase
              .from("files")
              .update({ path: oldPath, parent_id: file.parent_id })
              .eq("id", fileId);

            return NextResponse.json(
              { error: moveError.message || "Failed to move file in storage" },
              { status: 500 },
            );
          }

          // Update storage_path in database
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
            .eq("project_id", id)
            .like("path", `${oldPath}/%`)
            .eq("is_deleted", false);

          if (descendantsError) {
            Sentry.captureException(descendantsError);
          } else if (descendants && descendants.length > 0) {
            const storageClient = createStorageClient();
            // Update descendant paths and storage_paths
            await Promise.all(
              descendants.map(async (child) => {
                const childNewPath = `${newPath}${child.path.slice(oldPath.length)}`;
                const updates: Record<string, any> = {
                  path: childNewPath,
                  updated_by: user.id,
                };

                // Move in storage if has storage_path
                if (child.storage_path) {
                  const childNewStoragePath = `${id}/${childNewPath}`;
                  const { error: moveError } = await storageClient.storage
                    .from("project-files")
                    .move(child.storage_path, childNewStoragePath);

                  if (!moveError) {
                    updates.storage_path = childNewStoragePath;
                  } else {
                    Sentry.captureException(moveError);
                  }
                }

                return supabase
                  .from("files")
                  .update(updates)
                  .eq("id", child.id);
              }),
            );
          }
        }

        try {
          await cache.del(`project-files:${id}`);
        } catch (cacheError) {
          Sentry.captureException(cacheError, {
            data: { operation: "project_files_cache_invalidate", projectId: id },
          });
        }

        return NextResponse.json({ file: resolvedUpdatedFile });
      } catch (error) {
        Sentry.captureException(error);
        return NextResponse.json(
          { error: "Internal server error" },
          { status: 500 },
        );
      }
    },
  );
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  return Sentry.startSpan(
    {
      op: "http.server",
      name: "DELETE /api/projects/[id]/files/[fileId]",
    },
    async () => {
      try {
        const { id, fileId } = await params;
        const cookieStore = await cookies();
        const supabase = createClient(cookieStore);

        const {
          data: { user },
          error: authError,
        } = await supabase.auth.getUser();

        if (authError || !user) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const access = await requireProjectAccess(supabase, id, user.id);
        if (!access.ok) {
          return NextResponse.json(
            { error: "Project not found or access denied" },
            { status: 404 },
          );
        }

        const { data: file, error: fileError } = await supabase
          .from("files")
          .select("id, type, path, storage_path")
          .eq("id", fileId)
          .eq("project_id", id)
          .eq("is_deleted", false)
          .single();

        if (fileError || !file) {
          return NextResponse.json(
            { error: "File not found" },
            { status: 404 },
          );
        }

        // Soft delete from database
        await supabase
          .from("files")
          .update({ is_deleted: true, updated_by: user.id })
          .eq("id", fileId);

        const storageClient = createStorageClient();

        // Delete from storage if it exists
        if (file.storage_path) {
          const { error: storageError } = await storageClient.storage
            .from("project-files")
            .remove([file.storage_path]);

          if (storageError) {
            Sentry.captureException(storageError);
            // Continue even if storage delete fails
          }
        }

        if (file.type === "folder") {
          // Get all descendant files
          const { data: descendants } = await supabase
            .from("files")
            .select("storage_path")
            .eq("project_id", id)
            .like("path", `${file.path}/%`)
            .eq("is_deleted", false);

          // Soft delete descendants
          await supabase
            .from("files")
            .update({ is_deleted: true, updated_by: user.id })
            .eq("project_id", id)
            .like("path", `${file.path}/%`);

          // Delete descendant storage files
          if (descendants && descendants.length > 0) {
            const storagePaths = descendants
              .map((d) => d.storage_path)
              .filter((path): path is string => path !== null);

            if (storagePaths.length > 0) {
              const { error: storageError } = await storageClient.storage
                .from("project-files")
                .remove(storagePaths);

              if (storageError) {
                Sentry.captureException(storageError);
                // Continue even if storage delete fails
              }
            }
          }
        }

        try {
          await cache.del(`project-files:${id}`);
        } catch (cacheError) {
          Sentry.captureException(cacheError, {
            data: { operation: "project_files_cache_invalidate", projectId: id },
          });
        }

        return NextResponse.json({ deletedPath: file.path });
      } catch (error) {
        Sentry.captureException(error);
        return NextResponse.json(
          { error: "Internal server error" },
          { status: 500 },
        );
      }
    },
  );
}
