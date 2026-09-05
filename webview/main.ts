import type { ChatRole, HostToWebviewMessage, WebviewToHostMessage } from "../src/types";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHostMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

const statusEl = document.getElementById("status")!;
const apiKeyBanner = document.getElementById("apiKeyBanner")!;
const setApiKeyBtn = document.getElementById("setApiKeyBtn")!;
const goalOverlay = document.getElementById("goalOverlay")!;
const goalInput = document.getElementById("goalInput") as HTMLTextAreaElement;
const startBtn = document.getElementById("startBtn")!;
const chatLog = document.getElementById("chatLog")!;
const controls = document.getElementById("controls")!;
const micBtn = document.getElementById("micBtn") as HTMLButtonElement;
const stuckBtn = document.getElementById("stuckBtn")!;
const textInput = document.getElementById("textInput") as HTMLInputElement;
const sendBtn = document.getElementById("sendBtn")!;
const endBtn = document.getElementById("endBtn")!;

const bubbles = new Map<string, HTMLDivElement>();

let watchingFile: string | null = null;

function setStatus(): void {
  const file = watchingFile ? `watching: ${watchingFile}` : "not watching a file";
  statusEl.textContent = `Nudge — ${file}`;
}

function appendBubble(role: ChatRole, text: string, streamId: string): void {
  if (role === "system") {
    return;
  }
  let bubble = bubbles.get(streamId);
  if (!bubble) {
    bubble = document.createElement("div");
    bubble.className = `bubble ${role}`;
    chatLog.appendChild(bubble);
    bubbles.set(streamId, bubble);
  }
  bubble.textContent += text;
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addLocalUserMessage(text: string): void {
  appendBubble("user", text, `local-${Math.random().toString(36).slice(2)}`);
}

// ---- incoming messages from the extension host ----
window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "state": {
      apiKeyBanner.style.display = message.hasApiKey ? "none" : "flex";
      goalOverlay.style.display = !message.sessionActive && message.hasApiKey ? "flex" : "none";
      chatLog.style.display = message.sessionActive ? "flex" : "none";
      controls.style.display = message.sessionActive ? "flex" : "none";
      watchingFile = message.watchingFile;
      micBtn.textContent = message.micEnabled ? "Voice: on" : "Voice: off";
      micBtn.classList.toggle("active", message.micEnabled);
      setStatus();
      break;
    }
    case "needsGoalPrompt":
      goalOverlay.style.display = "flex";
      break;
    case "fileChanged":
      watchingFile = message.path || null;
      setStatus();
      break;
    case "chatAppend":
      appendBubble(message.role, message.text, message.streamId);
      break;
    case "error":
      appendBubble("assistant", `⚠ ${message.message}`, `error-${Math.random().toString(36).slice(2)}`);
      break;
    case "connectionStatus":
      break;
  }
});

vscode.postMessage({ type: "ready" });

// ---- goal / session controls ----
startBtn.addEventListener("click", () => {
  const goal = goalInput.value.trim();
  if (!goal) {
    return;
  }
  vscode.postMessage({ type: "startSession", goal });
  goalOverlay.style.display = "none";
  chatLog.style.display = "flex";
  controls.style.display = "flex";
});

setApiKeyBtn.addEventListener("click", () => vscode.postMessage({ type: "setApiKey" }));

endBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "endSession" });
  chatLog.style.display = "none";
  controls.style.display = "none";
  goalOverlay.style.display = "flex";
});

stuckBtn.addEventListener("click", () => vscode.postMessage({ type: "stuck" }));

// Mic capture/playback happen natively in the extension host (ffmpeg/ffplay) —
// this button just toggles that on/off; the host reports back via "state"
// whether it actually turned on (e.g. it won't if ffmpeg isn't installed).
let micRequested = false;
micBtn.addEventListener("click", () => {
  micRequested = !micRequested;
  vscode.postMessage({ type: "micToggle", enabled: micRequested });
});

sendBtn.addEventListener("click", sendTypedMessage);
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    sendTypedMessage();
  }
});

function sendTypedMessage(): void {
  const text = textInput.value.trim();
  if (!text) {
    return;
  }
  addLocalUserMessage(text);
  vscode.postMessage({ type: "userText", text });
  textInput.value = "";
}
