import * as vscode from "vscode";
import { NudgeViewProvider } from "./panelProvider";
import * as config from "./config";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new NudgeViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(NudgeViewProvider.viewType, provider),
    provider,
    vscode.commands.registerCommand("nudge.setApiKey", async () => {
      const key = await config.promptForApiKey(context);
      if (key) {
        await provider.refreshState();
      }
    }),
    vscode.commands.registerCommand("nudge.endSession", () => provider.endSessionAndNotify()),
    vscode.commands.registerCommand("nudge.clearLearningProfile", async () => {
      const confirm = await vscode.window.showWarningMessage(
        "Reset Nudge's learning profile? This clears all tracked weak topics.",
        { modal: true },
        "Reset"
      );
      if (confirm === "Reset") {
        await provider.resetLearningProfile();
      }
    }),
    vscode.commands.registerCommand("nudge.showLogs", () => provider.showLogs()),
    vscode.commands.registerCommand("nudge.selectMicrophone", () => provider.selectMicrophoneCommand())
  );
}

export function deactivate(): void {
  // Disposables registered via context.subscriptions handle cleanup.
}
