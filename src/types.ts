export interface EditorSnapshot {
  filePath: string;
  languageId: string;
  cursorLine: number;
  selection: string;
  content: string;
  truncated: boolean;
}

export interface TopicStruggle {
  count: number;
  lastSeen: string;
  notes: string[];
}

export interface LearningProfileData {
  topics: Record<string, TopicStruggle>;
}

export type ChatRole = "user" | "assistant" | "system";

/** Messages sent from the webview to the extension host. */
export type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "startSession"; goal: string }
  | { type: "endSession" }
  | { type: "userText"; text: string }
  | { type: "stuck" }
  | { type: "micToggle"; enabled: boolean }
  | { type: "requestState" }
  | { type: "setApiKey" };

/** Messages sent from the extension host to the webview. Mic capture and speaker
 * playback both happen in the extension host (via ffmpeg/ffplay) — the webview
 * never touches raw audio, so no audio bytes cross this boundary. */
export type HostToWebviewMessage =
  | { type: "state"; hasApiKey: boolean; sessionActive: boolean; watchingFile: string | null; micEnabled: boolean }
  | { type: "needsGoalPrompt" }
  | { type: "fileChanged"; path: string }
  | { type: "chatAppend"; role: ChatRole; text: string; final: boolean; streamId: string }
  | { type: "error"; message: string }
  | { type: "connectionStatus"; connected: boolean };
