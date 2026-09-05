import * as vscode from "vscode";
import { EditorSnapshot } from "./types";

/**
 * Snapshots the file the user is currently editing. If it's longer than
 * maxChars, keeps a window centered on the cursor so the model sees the
 * relevant part rather than an arbitrary head/tail slice.
 */
export function getActiveEditorSnapshot(maxChars: number): EditorSnapshot | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }

  const document = editor.document;
  const fullContent = document.getText();
  const cursorOffset = document.offsetAt(editor.selection.active);
  const selection = document.getText(editor.selection);

  let content = fullContent;
  let truncated = false;
  if (fullContent.length > maxChars) {
    truncated = true;
    const half = Math.floor(maxChars / 2);
    const start = Math.max(0, cursorOffset - half);
    const end = Math.min(fullContent.length, start + maxChars);
    content = fullContent.slice(start, end);
  }

  return {
    filePath: vscode.workspace.asRelativePath(document.uri, false),
    languageId: document.languageId,
    cursorLine: editor.selection.active.line + 1,
    selection,
    content,
    truncated,
  };
}

export type FileEditMode = "insert_at_cursor" | "replace_selection";

/**
 * Writes tutor-authored example code into the active file — used only when the
 * user has explicitly asked to be shown/walked through something, never as a
 * silent way to hand over a solution. Always targets the currently active
 * editor, same scope boundary as get_editor_context. A normal, immediately
 * undoable (Cmd+Z) edit — not a special destructive action.
 */
export async function applyEditToActiveEditor(
  mode: FileEditMode,
  code: string
): Promise<{ ok: boolean; error?: string }> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return { ok: false, error: "No active editor open." };
  }

  const useReplace = mode === "replace_selection" && !editor.selection.isEmpty;
  const success = await editor.edit((editBuilder) => {
    if (useReplace) {
      editBuilder.replace(editor.selection, code);
    } else {
      editBuilder.insert(editor.selection.active, code);
    }
  });

  if (!success) {
    return { ok: false, error: "VS Code rejected the edit (e.g. the document changed concurrently)." };
  }
  editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  return { ok: true };
}
