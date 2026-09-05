import * as vscode from "vscode";
import * as crypto from "crypto";
import { ActivityTracker } from "./activityTracker";
import { checkFfmpegAvailable, listMicDevices, MicCapture, SpeakerPlayback } from "./audioIO";
import { applyEditToActiveEditor, FileEditMode, getActiveEditorSnapshot } from "./contextProvider";
import * as config from "./config";
import { LearningProfile } from "./learningProfile";
import { RealtimeSession } from "./realtimeSession";
import { buildInstructions, TOOLS } from "./systemPrompt";
import { HostToWebviewMessage, WebviewToHostMessage } from "./types";

interface MicQuickPickItem extends vscode.QuickPickItem {
  index: number;
}

export class NudgeViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "nudge.chatView";

  private webviewView: vscode.WebviewView | undefined;
  private session: RealtimeSession | undefined;
  private tracker: ActivityTracker | undefined;
  private micCapture: MicCapture | undefined;
  private speakerPlayback: SpeakerPlayback | undefined;
  private lastPlaybackItemId: string | null = null;
  private readonly learningProfile: LearningProfile;
  private readonly outputChannel: vscode.OutputChannel;

  private sessionActive = false;
  private voiceEnabled = false;
  private watchingFile: string | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.learningProfile = new LearningProfile(context);
    this.outputChannel = vscode.window.createOutputChannel("Nudge");
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewToHostMessage) => this.handleMessage(message));
    webviewView.onDidDispose(() => this.endSession());
  }

  private post(message: HostToWebviewMessage): void {
    this.webviewView?.webview.postMessage(message);
  }

  private async handleMessage(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case "ready":
      case "requestState":
        await this.sendState();
        if (!this.sessionActive) {
          this.post({ type: "needsGoalPrompt" });
        }
        break;

      case "setApiKey": {
        const key = await config.promptForApiKey(this.context);
        if (key) {
          await this.sendState();
        }
        break;
      }

      case "startSession":
        await this.startSession(message.goal);
        break;

      case "endSession":
        await this.endSessionAndNotify();
        break;

      case "userText":
        this.session?.sendText(message.text, this.voiceEnabled);
        break;

      case "stuck":
        this.session?.triggerProactive(
          "The user just indicated out loud or via a button that they're stuck. Warmly ask what specifically is tripping them up before offering the first small hint.",
          this.voiceEnabled
        );
        break;

      case "micToggle":
        await this.setVoiceEnabled(message.enabled);
        break;
    }
  }

  private async setVoiceEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      this.voiceEnabled = await this.tryStartVoice();
    } else {
      this.stopVoice();
      this.voiceEnabled = false;
    }
    await this.sendState();
  }

  private async tryStartVoice(): Promise<boolean> {
    if (process.platform === "win32") {
      this.post({ type: "error", message: "Microphone capture isn't supported on Windows yet — use text chat instead." });
      return false;
    }
    if (!(await checkFfmpegAvailable())) {
      this.post({ type: "error", message: "Voice needs ffmpeg installed (brew install ffmpeg) — using text for now." });
      return false;
    }

    let deviceIndex = config.getMicDeviceIndex();
    if (deviceIndex < 0) {
      const picked = await this.pickMicrophone();
      if (picked === undefined) {
        return false;
      }
      deviceIndex = picked;
    }

    this.micCapture = new MicCapture(this.handleMicChunk, (message) => this.post({ type: "error", message }));
    this.micCapture.start(deviceIndex);
    this.speakerPlayback = new SpeakerPlayback((message) => this.post({ type: "error", message }));
    return true;
  }

  /** Gated so the mic isn't forwarded to the model while the tutor is speaking
   * (nudge.autoMuteDuringPlayback) — otherwise it can pick up its own voice
   * through the speakers and self-trigger an interruption. */
  private readonly handleMicChunk = (base64: string): void => {
    if (config.getAutoMuteDuringPlayback() && this.speakerPlayback?.playing) {
      return;
    }
    this.session?.appendAudio(base64);
  };

  private stopVoice(): void {
    this.micCapture?.stop();
    this.micCapture = undefined;
    this.speakerPlayback?.dispose();
    this.speakerPlayback = undefined;
    this.lastPlaybackItemId = null;
  }

  private async pickMicrophone(): Promise<number | undefined> {
    const devices = await listMicDevices();
    if (devices.length === 0) {
      this.post({ type: "error", message: "No microphones found." });
      return undefined;
    }
    const items: MicQuickPickItem[] = devices.map((d) => ({
      label: d.name,
      description: `index ${d.index}`,
      index: d.index,
    }));
    const pick = await vscode.window.showQuickPick(items, { title: "Nudge: Select Microphone", ignoreFocusOut: true });
    if (!pick) {
      return undefined;
    }
    await config.setMicDeviceIndex(pick.index);
    return pick.index;
  }

  /** Backing command for "Nudge: Select Microphone" — usable any time, and restarts
   * capture immediately if a voice session is already running. */
  async selectMicrophoneCommand(): Promise<void> {
    const picked = await this.pickMicrophone();
    if (picked === undefined) {
      return;
    }
    if (this.voiceEnabled && this.session) {
      this.micCapture?.stop();
      this.micCapture = new MicCapture(this.handleMicChunk, (message) => this.post({ type: "error", message }));
      this.micCapture.start(picked);
    }
  }

  private async startSession(goal: string): Promise<void> {
    let apiKey = await config.getApiKey(this.context);
    if (!apiKey) {
      apiKey = await config.promptForApiKey(this.context);
    }
    if (!apiKey) {
      this.post({ type: "error", message: "An OpenAI API key is required to start a session." });
      return;
    }

    const instructions = buildInstructions(goal, this.learningProfile.getSummaryForPrompt());

    this.session = new RealtimeSession(
      {
        onOpen: () => this.post({ type: "connectionStatus", connected: true }),
        onClose: (reason) => {
          this.outputChannel.appendLine(`connection closed: ${reason}`);
          this.post({ type: "connectionStatus", connected: false });
        },
        onError: (msg) => this.post({ type: "error", message: msg }),
        onAssistantDelta: (itemId, delta) =>
          this.post({ type: "chatAppend", role: "assistant", text: delta, final: false, streamId: itemId }),
        onAssistantDone: (itemId) =>
          this.post({ type: "chatAppend", role: "assistant", text: "", final: true, streamId: itemId }),
        onUserTranscript: (text) =>
          this.post({ type: "chatAppend", role: "user", text, final: true, streamId: crypto.randomUUID() }),
        onAudioDelta: (itemId, base64) => {
          if (this.lastPlaybackItemId !== itemId) {
            this.lastPlaybackItemId = itemId;
            this.speakerPlayback?.resetForNewItem();
          }
          this.speakerPlayback?.write(base64);
        },
        onAudioDone: () => this.speakerPlayback?.markResponseAudioDone(),
        onSpeechStarted: () => {
          // turn_detection.interrupt_response is already true, so the server
          // handles interrupting the in-flight response itself — calling
          // response.cancel here too raced against that (it targets "whatever
          // response is currently active," which by the time it arrived was
          // sometimes already the *next* auto-created response, clipping the
          // wrong one). We still need to stop audio we've already buffered
          // locally and tell the server how much of it was actually heard.
          if (this.session?.isResponseActive && this.speakerPlayback && this.lastPlaybackItemId) {
            const elapsedMs = this.speakerPlayback.stopAndFlush();
            this.session.truncateAssistantAudio(this.lastPlaybackItemId, elapsedMs);
          }
        },
        onFunctionCall: (callId, name, argsJson) => this.handleFunctionCall(callId, name, argsJson),
        onResponseDone: () => {
          // Safety net alongside onAudioDone — e.g. a text-only or cancelled
          // response never fires response.output_audio.done at all.
          this.speakerPlayback?.markResponseAudioDone();
          this.lastPlaybackItemId = null;
        },
      },
      this.outputChannel
    );

    this.session.connect({
      apiKey,
      model: config.getRealtimeModel(),
      voice: config.getVoice(),
      instructions,
      tools: TOOLS,
    });

    this.sessionActive = true;
    this.tracker = new ActivityTracker(config.getIdleThresholdMs(), {
      onFileChanged: (path) => {
        this.watchingFile = path;
        this.post({ type: "fileChanged", path: path ?? "" });
      },
      onActivity: () => undefined,
      onIdle: () => {
        this.session?.triggerProactive(
          "The user has been idle (no typing) in their file for a while. Proactively and warmly check in — reference what they were likely last looking at if you have context for it, rather than a generic 'still there?'.",
          this.voiceEnabled
        );
      },
    });

    await this.sendState();
  }

  private handleFunctionCall(callId: string, name: string, argsJson: string): void {
    if (!this.session) {
      return;
    }
    if (name === "get_editor_context") {
      const snapshot = getActiveEditorSnapshot(config.getMaxContextChars());
      this.session.sendFunctionResult(callId, snapshot ?? { error: "No active editor open." }, this.voiceEnabled);
      return;
    }
    if (name === "record_topic_struggle") {
      try {
        const args = JSON.parse(argsJson) as { topic?: string; note?: string };
        if (args.topic && args.note) {
          void this.learningProfile.recordStruggle(args.topic, args.note);
        }
        this.session.sendFunctionResult(callId, { ok: true }, this.voiceEnabled);
      } catch {
        this.session.sendFunctionResult(callId, { ok: false, error: "Malformed arguments" }, this.voiceEnabled);
      }
      return;
    }
    if (name === "show_in_file") {
      try {
        const args = JSON.parse(argsJson) as { code?: string; mode?: FileEditMode };
        if (!args.code || !args.mode) {
          this.session.sendFunctionResult(callId, { ok: false, error: "Malformed arguments" }, this.voiceEnabled);
          return;
        }
        void applyEditToActiveEditor(args.mode, args.code).then((result) => {
          this.session?.sendFunctionResult(callId, result, this.voiceEnabled);
        });
      } catch {
        this.session.sendFunctionResult(callId, { ok: false, error: "Malformed arguments" }, this.voiceEnabled);
      }
      return;
    }
    this.session.sendFunctionResult(callId, { error: `Unknown tool: ${name}` }, this.voiceEnabled);
  }

  private endSession(): void {
    this.session?.dispose();
    this.session = undefined;
    this.tracker?.dispose();
    this.tracker = undefined;
    this.stopVoice();
    this.sessionActive = false;
    this.watchingFile = null;
  }

  async endSessionAndNotify(): Promise<void> {
    this.endSession();
    await this.sendState();
  }

  async refreshState(): Promise<void> {
    await this.sendState();
  }

  private async sendState(): Promise<void> {
    const hasApiKey = Boolean(await config.getApiKey(this.context));
    this.post({
      type: "state",
      hasApiKey,
      sessionActive: this.sessionActive,
      watchingFile: this.watchingFile,
      micEnabled: this.voiceEnabled,
    });
  }

  async resetLearningProfile(): Promise<void> {
    await this.learningProfile.reset();
    vscode.window.showInformationMessage("Nudge: learning profile reset.");
  }

  showLogs(): void {
    this.outputChannel.show();
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"));
    const nonce = crypto.randomBytes(16).toString("base64");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Nudge</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); padding: 0; margin: 0; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
    #status { padding: 6px 10px; font-size: 12px; opacity: 0.75; border-bottom: 1px solid var(--vscode-panel-border); }
    #goalOverlay { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    #chatLog { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    .bubble { padding: 6px 10px; border-radius: 8px; max-width: 92%; white-space: pre-wrap; word-wrap: break-word; }
    .user { align-self: flex-end; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .assistant { align-self: flex-start; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); }
    #controls { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--vscode-panel-border); }
    #textInput { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 4px 6px; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 4px 8px; cursor: pointer; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button.active { outline: 2px solid var(--vscode-focusBorder); }
    textarea { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 6px; box-sizing: border-box; }
    #apiKeyBanner { display: none; padding: 10px; gap: 6px; flex-direction: column; }
  </style>
</head>
<body>
  <div id="status">Nudge — not watching a file</div>
  <div id="apiKeyBanner">
    <div>Set your OpenAI API key to start a session.</div>
    <button id="setApiKeyBtn">Set API Key</button>
  </div>
  <div id="goalOverlay">
    <div>What are you working on?</div>
    <textarea id="goalInput" rows="3" placeholder="e.g. LeetCode 3 - Longest Substring Without Repeating Characters"></textarea>
    <button id="startBtn">Start session</button>
  </div>
  <div id="chatLog" style="display:none;"></div>
  <div id="controls" style="display:none;">
    <button id="micBtn" class="secondary" title="Toggle voice">Voice: off</button>
    <button id="stuckBtn" class="secondary">I'm stuck</button>
    <input id="textInput" placeholder="Type a message..." />
    <button id="sendBtn">Send</button>
    <button id="endBtn" class="secondary">End</button>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.endSession();
    this.outputChannel.dispose();
  }
}
