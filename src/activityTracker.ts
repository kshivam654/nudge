import * as vscode from "vscode";

export interface ActivityTrackerEvents {
  onFileChanged: (path: string | null) => void;
  onIdle: () => void;
  onActivity: () => void;
}

/**
 * Watches only the currently active editor's document (never the whole
 * workspace) and reports idle periods so the tutor can proactively check in.
 */
export class ActivityTracker implements vscode.Disposable {
  private trackedUri: vscode.Uri | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private nudgeSentForCurrentIdlePeriod = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly idleThresholdMs: number, private readonly events: ActivityTrackerEvents) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => this.handleActiveEditorChanged(editor)),
      vscode.workspace.onDidChangeTextDocument((e) => this.handleDocumentChanged(e))
    );
    this.handleActiveEditorChanged(vscode.window.activeTextEditor);
  }

  private handleActiveEditorChanged(editor: vscode.TextEditor | undefined): void {
    const uri = editor?.document.uri;
    if (uri?.toString() === this.trackedUri?.toString()) {
      return;
    }
    this.trackedUri = uri;
    this.events.onFileChanged(uri ? vscode.workspace.asRelativePath(uri, false) : null);
    this.rearmIdleTimer();
  }

  private handleDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    if (e.contentChanges.length === 0) {
      return;
    }
    if (e.document.uri.toString() !== this.trackedUri?.toString()) {
      return;
    }
    this.nudgeSentForCurrentIdlePeriod = false;
    this.events.onActivity();
    this.rearmIdleTimer();
  }

  private rearmIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    if (!this.trackedUri) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      if (!this.nudgeSentForCurrentIdlePeriod) {
        this.nudgeSentForCurrentIdlePeriod = true;
        this.events.onIdle();
      }
    }, this.idleThresholdMs);
  }

  dispose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
