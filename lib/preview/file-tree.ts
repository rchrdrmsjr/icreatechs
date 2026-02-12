import type { FileSystemTree } from "@webcontainer/api";

type FlatFile = {
  path: string;
  type: "file" | "folder";
  content?: string | null;
};

const normalizePath = (path: string) =>
  path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

export const buildFileTree = (files: FlatFile[]): FileSystemTree => {
  const tree: FileSystemTree = {};

  for (const file of files) {
    if (!file.path) continue;
    const normalized = normalizePath(file.path);
    if (!normalized) continue;
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    let current = tree;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (isLast) {
        if (file.type === "folder") {
          current[part] = { directory: {} };
        } else {
          current[part] = { file: { contents: file.content ?? "" } };
        }
        continue;
      }

      if (!current[part]) {
        current[part] = { directory: {} };
      }
      const node = current[part];
      if ("directory" in node) {
        current = node.directory;
      }
    }
  }

  return tree;
};
