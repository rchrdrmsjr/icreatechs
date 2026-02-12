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
): Promise<{ id: string; path: string } | null> => {
  if (!parentId) return null;

  // Check if parentId looks like a UUID (36 chars with hyphens in correct positions)
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parentId);

  let parent;

  if (isUUID) {
    // Query by ID (original behavior for UUID format)
    const { data, error: parentError } = await supabase
      .from("files")
      .select("id, path, type")
      .eq("id", parentId)
      .eq("project_id", projectId)
      .eq("is_deleted", false)
      .maybeSingle();

    if (parentError || !data) {
      throw new Error("Parent folder not found");
    }
    parent = data;
  } else {
    // Query by path (fallback for when AI uses folder name/path)
    const { data, error: parentError } = await supabase
      .from("files")
      .select("id, path, type")
      .eq("path", parentId)
      .eq("project_id", projectId)
      .eq("is_deleted", false)
      .maybeSingle();

    if (parentError || !data) {
      throw new Error("Parent folder not found");
    }
    parent = data;
  }

  if (parent.type !== "folder") {
    throw new Error("Parent must be a folder");
  }

  return { id: parent.id, path: parent.path };
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
