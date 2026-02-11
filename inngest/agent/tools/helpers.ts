import { createAdminClient } from "@/utils/supabase/admin";

export const normalizePath = (parentPath: string | null, name: string) => {
  const trimmedName = name.trim();
  const basePath = parentPath ? parentPath.replace(/\/+$|\/$/g, "") : "";
  return basePath ? `${basePath}/${trimmedName}` : trimmedName;
};

export const normalizeInputPath = (rawPath: string) => {
  let path = rawPath.trim();
  if (path.startsWith("@")) {
    path = path.slice(1);
  }
  path = path.replace(/\\/g, "/");
  path = path.replace(/^\.?\//, "");
  path = path.replace(/^\/+/, "");
  return path;
};

export const normalizeParentId = (parentId?: string | null) =>
  parentId && parentId.trim() !== "" ? parentId : null;

export const loadParentPath = async (
  supabase: ReturnType<typeof createAdminClient>,
  projectId: string,
  parentId: string | null,
) => {
  if (!parentId) return null;

  const { data: parent, error: parentError } = await supabase
    .from("files")
    .select("id, path, type")
    .eq("id", parentId)
    .eq("project_id", projectId)
    .eq("is_deleted", false)
    .maybeSingle();

  if (parentError || !parent) {
    throw new Error("Parent folder not found");
  }

  if (parent.type !== "folder") {
    throw new Error("Parent must be a folder");
  }

  return parent.path;
};

export const findFileByPath = async (
  supabase: ReturnType<typeof createAdminClient>,
  projectId: string,
  path: string,
) => {
  const { data: existing } = await supabase
    .from("files")
    .select("id, name, type, parent_id, path, storage_path")
    .eq("project_id", projectId)
    .eq("path", path)
    .eq("is_deleted", false)
    .maybeSingle();

  return existing ?? null;
};

export const findFileById = async (
  supabase: ReturnType<typeof createAdminClient>,
  projectId: string,
  fileId: string,
) => {
  const { data: file, error } = await supabase
    .from("files")
    .select("id, name, type, parent_id, path, content, storage_path")
    .eq("id", fileId)
    .eq("project_id", projectId)
    .eq("is_deleted", false)
    .maybeSingle();

  if (error || !file) {
    return null;
  }

  return file;
};

export const computeSizeBytes = (content: string) =>
  new TextEncoder().encode(content).length;
