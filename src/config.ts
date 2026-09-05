import * as vscode from "vscode";

const SECRET_KEY = "nudge.openaiApiKey";

export function getVoice(): string {
  return vscode.workspace.getConfiguration("nudge").get<string>("voice", "marin");
}

export function getRealtimeModel(): string {
  return vscode.workspace.getConfiguration("nudge").get<string>("realtimeModel", "gpt-realtime-2.1");
}

export function getIdleThresholdMs(): number {
  const seconds = vscode.workspace.getConfiguration("nudge").get<number>("idleThresholdSeconds", 45);
  return seconds * 1000;
}

export function getMaxContextChars(): number {
  return vscode.workspace.getConfiguration("nudge").get<number>("maxContextChars", 6000);
}

export function getMicDeviceIndex(): number {
  return vscode.workspace.getConfiguration("nudge").get<number>("micDeviceIndex", -1);
}

export async function setMicDeviceIndex(index: number): Promise<void> {
  await vscode.workspace.getConfiguration("nudge").update("micDeviceIndex", index, vscode.ConfigurationTarget.Global);
}

export function getAutoMuteDuringPlayback(): boolean {
  return vscode.workspace.getConfiguration("nudge").get<boolean>("autoMuteDuringPlayback", true);
}

export async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(SECRET_KEY);
}

export async function setApiKey(context: vscode.ExtensionContext, key: string): Promise<void> {
  await context.secrets.store(SECRET_KEY, key);
}

export async function promptForApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    title: "Nudge: OpenAI API Key",
    prompt: "Enter your OpenAI API key (used only locally to connect to the Realtime API).",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length > 0 ? undefined : "API key cannot be empty"),
  });
  if (!key) {
    return undefined;
  }
  await setApiKey(context, key.trim());
  return key.trim();
}
