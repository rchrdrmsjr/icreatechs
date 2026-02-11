"use client";

import { Loader2, X } from "lucide-react";
import { FileIcon } from "@react-symbols/icons/utils";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/lib/editor-store";

interface EditorTabsProps {
  savingIds?: Set<string>;
}

export function EditorTabs({ savingIds }: EditorTabsProps) {
  const openFiles = useEditorStore((state) => state.openFiles);
  const activeFileId = useEditorStore((state) => state.activeFileId);
  const mruIds = useEditorStore((state) => state.mruIds);
  const setActiveFile = useEditorStore((state) => state.setActiveFile);
  const closeFile = useEditorStore((state) => state.closeFile);

  const filesById = new Map(openFiles.map((file) => [file.id, file]));
  const orderedFiles = mruIds
    .map((id) => filesById.get(id))
    .filter((file): file is NonNullable<typeof file> => Boolean(file));

  if (orderedFiles.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-1 border-b border-border bg-background px-2 py-1">
      {orderedFiles.map((file) => (
        <div
          key={file.id}
          role="button"
          tabIndex={0}
          onClick={() => setActiveFile(file.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setActiveFile(file.id);
            }
          }}
          className={cn(
            "group flex items-center gap-2 rounded px-3 py-1 text-xs",
            activeFileId === file.id ? "bg-accent" : "text-muted-foreground",
          )}
        >
          <FileIcon fileName={file.name} autoAssign={true} className="h-3.5 w-3.5" />
          <span className="max-w-35 truncate">{file.name}</span>
          <span className="text-[10px] text-muted-foreground">
            {savingIds?.has(file.id) ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : file.isDirty ? (
              <span className="text-amber-400">*</span>
            ) : null}
          </span>
          <button
            type="button"
            aria-label="Close tab"
            title="Close tab"
            className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              closeFile(file.id);
            }}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
