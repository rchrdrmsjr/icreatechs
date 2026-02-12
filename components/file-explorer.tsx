"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { FileIcon } from "@react-symbols/icons/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface FileRecord {
  id: string;
  name: string;
  type: "file" | "folder";
  parent_id: string | null;
  path: string;
}

interface FileNode extends FileRecord {
  children: FileNode[];
}

interface FileExplorerProps {
  projectId: string;
  onOpenFile?: (file: FileRecord) => void;
}

function sortNodes(nodes: FileNode[]) {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

function buildTree(files: FileRecord[]) {
  const byId = new Map<string, FileNode>();

  for (const file of files) {
    byId.set(file.id, { ...file, children: [] });
  }

  const roots: FileNode[] = [];

  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const normalize = (nodes: FileNode[]) => {
    const sorted = sortNodes(nodes);
    sorted.forEach((child) => {
      if (child.children.length > 0) {
        child.children = normalize(child.children);
      }
    });
    return sorted;
  };

  return normalize(roots);
}

export function FileExplorer({ projectId, onOpenFile }: FileExplorerProps) {
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [createType, setCreateType] = useState<"file" | "folder">("file");
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [isRootDropActive, setIsRootDropActive] = useState(false);

  useEffect(() => {
    let mounted = true;

    const fetchFiles = async () => {
      try {
        setLoading(true);
        const response = await fetch(`/api/projects/${projectId}/files`);
        if (!response.ok) {
          throw new Error("Failed to fetch files");
        }
        const data = await response.json();
        if (mounted) {
          setFiles(data.files || []);
          setError(null);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : "Failed to load files");
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    fetchFiles();

    return () => {
      mounted = false;
    };
  }, [projectId]);

  const tree = useMemo(() => buildTree(files), [files]);
  const fileById = useMemo(() => {
    const map = new Map<string, FileRecord>();
    files.forEach((file) => map.set(file.id, file));
    return map;
  }, [files]);
  const selectedFile = selectedId ? fileById.get(selectedId) ?? null : null;

  const openCreateDialog = (type: "file" | "folder") => {
    setCreateType(type);
    setNewName("");
    setCreateError(null);
    setDialogOpen(true);
  };

  const openRenameDialog = (fileId?: string) => {
    const file = fileId ? fileById.get(fileId) : selectedFile;
    if (!file) return;
    setRenameValue(file.name);
    setRenameError(null);
    setRenameOpen(true);
  };

  const openDeleteDialog = (fileId?: string) => {
    const file = fileId ? fileById.get(fileId) : selectedFile;
    if (!file) return;
    setDeleteError(null);
    setDeleteOpen(true);
  };

  const handleRefresh = async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/files`);
      if (!response.ok) {
        throw new Error("Failed to fetch files");
      }
      const data = await response.json();
      setFiles(data.files || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load files");
    } finally {
      setLoading(false);
    }
  };

  const handleCollapseAll = () => {
    setExpandedIds(new Set());
  };

  const resolveParentId = () => {
    if (!selectedId) return null;
    const selected = fileById.get(selectedId);
    if (!selected) return null;
    if (selected.type === "folder") return selected.id;
    return selected.parent_id || null;
  };

  const handleCreate = async () => {
    const trimmedName = newName.trim();
    if (!trimmedName) {
      setCreateError("Name is required");
      return;
    }

    setIsCreating(true);
    setCreateError(null);

    try {
      const parentId = resolveParentId();
      const response = await fetch(`/api/projects/${projectId}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          type: createType,
          parent_id: parentId,
          content: createType === "file" ? "" : undefined,
        }),
      });

      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || "Failed to create");
      }

      const { file } = await response.json();
      setFiles((prev) => [...prev, file]);
      if (parentId) {
        setExpandedIds((prev) => new Set(prev).add(parentId));
      }
      if (file.type === "folder") {
        setExpandedIds((prev) => new Set(prev).add(file.id));
      }
      setSelectedId(file.id);
      setDialogOpen(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setIsCreating(false);
    }
  };

  const handleRename = async () => {
    if (!selectedFile) return;
    const trimmedName = renameValue.trim();
    if (!trimmedName) {
      setRenameError("Name is required");
      return;
    }

    setIsRenaming(true);
    setRenameError(null);

    try {
      const response = await fetch(
        `/api/projects/${projectId}/files/${selectedFile.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmedName }),
        },
      );

      if (!response.ok) {
        let message = "Failed to rename";
        try {
          const payload = await response.json();
          if (payload?.error) {
            message = payload.error;
          }
        } catch {
          // Ignore JSON parse errors and keep default message.
        }
        throw new Error(message);
      }

      const { file } = await response.json();
      const oldPath = selectedFile.path;
      const newPath = file.path as string;

      setFiles((prev) =>
        prev.map((item) => {
          if (item.id === file.id) {
            return { ...item, name: file.name, path: newPath };
          }

          if (
            selectedFile.type === "folder" &&
            item.path.startsWith(`${oldPath}/`)
          ) {
            return {
              ...item,
              path: `${newPath}${item.path.slice(oldPath.length)}`,
            };
          }

          return item;
        }),
      );

      setRenameOpen(false);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "Failed to rename");
    } finally {
      setIsRenaming(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedFile) return;
    setIsDeleting(true);
    setDeleteError(null);

    try {
      const response = await fetch(
        `/api/projects/${projectId}/files/${selectedFile.id}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || "Failed to delete");
      }

      const deletedPath = selectedFile.path;
      setFiles((prev) =>
        prev.filter(
          (item) =>
            item.path !== deletedPath &&
            !item.path.startsWith(`${deletedPath}/`),
        ),
      );
      setSelectedId(null);
      setDeleteOpen(false);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setIsDeleting(false);
    }
  };

  const isInvalidDrop = (dragId: string, targetId: string | null) => {
    const dragged = fileById.get(dragId);
    if (!dragged) return true;
    if (targetId === null) return false;
    if (dragId === targetId) return true;
    const target = fileById.get(targetId);
    if (!target || target.type !== "folder") return true;
    if (dragged.type === "folder" && target.path.startsWith(`${dragged.path}/`)) {
      return true;
    }
    return false;
  };

  const handleMove = async (fileId: string, parentId: string | null) => {
    const file = fileById.get(fileId);
    if (!file || file.parent_id === parentId) return;

    try {
      const response = await fetch(
        `/api/projects/${projectId}/files/${fileId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parent_id: parentId }),
        },
      );

      if (!response.ok) {
        let message = "Failed to move";
        try {
          const payload = await response.json();
          if (payload?.error) {
            message = payload.error;
          }
        } catch {
          // Ignore JSON parse errors and keep default message.
        }
        throw new Error(message);
      }

      const { file: updatedFile } = await response.json();
      const oldPath = file.path;
      const newPath = updatedFile.path as string;

      setFiles((prev) =>
        prev.map((item) => {
          if (item.id === updatedFile.id) {
            return {
              ...item,
              name: updatedFile.name,
              parent_id: updatedFile.parent_id ?? null,
              path: newPath,
            };
          }

          if (file.type === "folder" && item.path.startsWith(`${oldPath}/`)) {
            return {
              ...item,
              path: `${newPath}${item.path.slice(oldPath.length)}`,
            };
          }

          return item;
        }),
      );

      if (parentId) {
        setExpandedIds((prev) => new Set(prev).add(parentId));
      }
      setSelectedId(updatedFile.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to move");
    }
  };

  const toggleFolder = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const renderNode = (node: FileNode, depth: number) => {
    const isFolder = node.type === "folder";
    const isExpanded = expandedIds.has(node.id);

    return (
      <ContextMenu key={node.id}>
        <ContextMenuTrigger asChild>
          <div>
            <button
              type="button"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", node.id);
                setDraggedId(node.id);
              }}
              onDragEnd={() => {
                setDraggedId(null);
                setDropTargetId(null);
                setIsRootDropActive(false);
              }}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedId(node.id);
                if (isFolder) {
                  toggleFolder(node.id);
                } else {
                  onOpenFile?.(node);
                }
              }}
              onDragOver={(event) => {
                if (!isFolder || !draggedId) return;
                if (isInvalidDrop(draggedId, node.id)) return;
                event.stopPropagation();
                event.preventDefault();
                setDropTargetId(node.id);
                setIsRootDropActive(false);
              }}
              onDrop={(event) => {
                if (!isFolder || !draggedId) return;
                if (isInvalidDrop(draggedId, node.id)) return;
                event.stopPropagation();
                event.preventDefault();
                handleMove(draggedId, node.id);
                setDraggedId(null);
                setDropTargetId(null);
              }}
              className={cn(
                "flex w-full items-center gap-1.5 rounded px-2 py-1 text-sm hover:bg-accent",
                selectedId === node.id && "bg-accent",
                dropTargetId === node.id && "ring-1 ring-primary"
              )}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
            >
              {isFolder ? (
                isExpanded ? (
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                )
              ) : (
                <span className="w-3" />
              )}
              {isFolder ? (
                isExpanded ? (
                  <FolderOpen className="h-4 w-4 text-blue-500" />
                ) : (
                  <Folder className="h-4 w-4 text-blue-500" />
                )
              ) : (
                <FileIcon fileName={node.name} autoAssign={true} className="h-4 w-4" />
              )}
              <span className="truncate">{node.name}</span>
            </button>
            {isFolder && isExpanded && node.children.length > 0 && (
              <div>
                {node.children.map((child) => renderNode(child, depth + 1))}
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => {
              setSelectedId(node.id);
              openRenameDialog(node.id);
            }}
          >
            <Pencil className="h-4 w-4" />
            Rename
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => {
              setSelectedId(node.id);
              openDeleteDialog(node.id);
            }}
            className="text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    <div
      className={cn(
        "space-y-2 -m-3 p-3 min-h-screen h-full border-l-2 transition-colors",
        selectedId === null
          ? "border-l-primary bg-primary/5"
          : "border-l-transparent",
        isRootDropActive && "ring-1 ring-primary/60"
      )}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          setSelectedId(null);
        }
      }}
      onDragOver={(event) => {
        if (!draggedId || isInvalidDrop(draggedId, null)) return;
        event.preventDefault();
        setIsRootDropActive(true);
        setDropTargetId(null);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) {
          setIsRootDropActive(false);
        }
      }}
      onDrop={(event) => {
        if (!draggedId || isInvalidDrop(draggedId, null)) return;
        event.preventDefault();
        handleMove(draggedId, null);
        setDraggedId(null);
        setDropTargetId(null);
        setIsRootDropActive(false);
      }}
    >
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase text-muted-foreground">
          Files
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => openCreateDialog("file")}
            title="New file"
          >
            <FilePlus className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => openCreateDialog("folder")}
            title="New folder"
          >
            <FolderPlus className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={handleRefresh}
            title="Refresh"
            disabled={loading}
          >
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={handleCollapseAll}
            title="Collapse All"
          >
            <ChevronsDownUp className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading files...
        </div>
      ) : error ? (
        <div className="text-sm text-destructive">{error}</div>
      ) : (
        <div className="min-h-50">
          {tree.length === 0 ? (
            <div className="text-sm text-muted-foreground px-2 py-1">
              No files yet. Create your first file or folder.
            </div>
          ) : (
            <div className="space-y-0.5 p-1">
              {tree.map((node) => renderNode(node, 0))}
            </div>
          )}
        </div>
      )}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {createType === "folder" ? "New Folder" : "New File"}
            </DialogTitle>
            <DialogDescription>
              {createType === "folder"
                ? selectedId
                  ? "Create a folder in the selected location."
                  : "Create a folder in the root directory."
                : selectedId
                  ? "Create a file in the selected location."
                  : "Create a file in the root directory."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder={createType === "folder" ? "folder-name" : "file-name.ts"}
            />
            {createError && (
              <div className="text-sm text-destructive">{createError}</div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={isCreating}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleCreate} disabled={isCreating}>
              {isCreating ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
            <DialogDescription>
              {selectedFile?.type === "folder"
                ? "Rename the selected folder."
                : "Rename the selected file."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
            />
            {renameError && (
              <div className="text-sm text-destructive">{renameError}</div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRenameOpen(false)}
              disabled={isRenaming}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleRename} disabled={isRenaming}>
              {isRenaming ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete</DialogTitle>
            <DialogDescription>
              {selectedFile?.type === "folder"
                ? "Delete this folder and all of its contents?"
                : "Delete this file?"}
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <div className="text-sm text-destructive">{deleteError}</div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
