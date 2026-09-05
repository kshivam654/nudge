import WebSocket from "ws";
import * as vscode from "vscode";

export interface RealtimeSessionCallbacks {
  onOpen: () => void;
  onClose: (reason: string) => void;
  onError: (message: string) => void;
  /** Streaming delta of what the assistant is saying/writing, keyed by response item id. */
  onAssistantDelta: (itemId: string, delta: string) => void;
  onAssistantDone: (itemId: string) => void;
  onUserTranscript: (text: string) => void;
  onAudioDelta: (itemId: string, base64: string) => void;
  onAudioDone: (itemId: string) => void;
  /** User started speaking while a response was playing back — caller should stop local playback. */
  onSpeechStarted: () => void;
  onFunctionCall: (callId: string, name: string, argsJson: string) => void;
  /** A response fully completed — good moment to clear any "current item" bookkeeping. */
  onResponseDone: () => void;
}

interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: unknown;
}

const REALTIME_BASE_URL = "wss://api.openai.com/v1/realtime";

/**
 * Owns the OpenAI Realtime WebSocket connection. Lives entirely in the
 * extension host so the API key never has to touch webview JS.
 */
export class RealtimeSession implements vscode.Disposable {
  private ws: WebSocket | undefined;
  private readonly handledCallIds = new Set<string>();
  private unkeyedEventCounter = 0;
  private readonly outputChannel: vscode.OutputChannel;
  /** True from response.created until response.done — guards against the API's
   * "Conversation already has an active response in progress" error. */
  private responseActive = false;
  private pendingAction: (() => void) | null = null;

  constructor(private readonly callbacks: RealtimeSessionCallbacks, outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  /** Whether a response is currently in flight — response.cancel/conversation.item.truncate
   * only make sense while this is true; the API errors otherwise ("no active response"). */
  get isResponseActive(): boolean {
    return this.responseActive;
  }

  connect(opts: {
    apiKey: string;
    model: string;
    voice: string;
    instructions: string;
    tools: readonly ToolDefinition[];
  }): void {
    const url = `${REALTIME_BASE_URL}?model=${encodeURIComponent(opts.model)}`;
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
    });

    this.ws.on("open", () => {
      this.send({
        type: "session.update",
        session: {
          type: "realtime",
          model: opts.model,
          instructions: opts.instructions,
          // Only one modality at a time: requesting both "audio" and "text" together makes
          // OpenAI emit two parallel delta streams (output_text.delta + output_audio_transcript.delta)
          // describing the same words, which would double up text in the chat log.
          output_modalities: ["audio"],
          tools: opts.tools,
          tool_choice: "auto",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              turn_detection: { type: "semantic_vad", interrupt_response: true, create_response: true },
              transcription: { model: "gpt-4o-mini-transcribe" },
            },
            output: {
              format: { type: "audio/pcm", rate: 24000 },
              voice: opts.voice,
            },
          },
        },
      });
      this.callbacks.onOpen();
    });

    this.ws.on("message", (raw) => this.handleServerEvent(raw.toString()));
    this.ws.on("error", (err) => this.callbacks.onError(err.message));
    this.ws.on("close", (code, reason) => this.callbacks.onClose(`${code} ${reason.toString()}`));
  }

  private handleServerEvent(raw: string): void {
    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    this.outputChannel.appendLine(`< ${event.type}`);

    switch (event.type) {
      case "session.created":
      case "session.updated":
        break;

      case "response.created":
        this.responseActive = true;
        break;

      case "response.output_text.delta":
        this.callbacks.onAssistantDelta(this.resolveKey(event), event.delta ?? "");
        break;

      case "response.output_audio_transcript.delta":
        this.callbacks.onAssistantDelta(this.resolveKey(event), event.delta ?? "");
        break;

      case "response.output_text.done":
      case "response.output_audio_transcript.done":
        this.callbacks.onAssistantDone(this.resolveKey(event));
        break;

      case "response.output_audio.delta":
        this.callbacks.onAudioDelta(this.resolveKey(event), event.delta ?? "");
        break;

      case "response.output_audio.done":
        this.callbacks.onAudioDone(this.resolveKey(event));
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (typeof event.transcript === "string" && event.transcript.trim().length > 0) {
          this.callbacks.onUserTranscript(event.transcript.trim());
        }
        break;

      case "input_audio_buffer.speech_started":
        this.callbacks.onSpeechStarted();
        break;

      case "response.function_call_arguments.done":
        this.dispatchFunctionCall(event.call_id, event.name, event.arguments ?? "{}");
        break;

      case "response.done": {
        const output = event.response?.output ?? [];
        for (const item of output) {
          if (item.type === "function_call") {
            this.dispatchFunctionCall(item.call_id, item.name, item.arguments ?? "{}");
          }
        }
        this.responseActive = false;
        this.callbacks.onResponseDone();
        const next = this.pendingAction;
        this.pendingAction = null;
        next?.();
        break;
      }

      case "error":
        this.callbacks.onError(event.error?.message ?? "Unknown realtime API error");
        break;

      default:
        // Logged above for debugging; not every event type needs handling.
        break;
    }
  }

  /** Bucket key for a delta/done event. Never falls back to a shared constant —
   * doing that once collapsed two genuinely different (overlapping) responses'
   * text into the same chat bubble, producing garbled/interleaved output. Prefer
   * item_id, then response_id (both should normally be present); only as a last
   * resort mint a unique per-event key so two different responses can never collide. */
  private resolveKey(event: any): string {
    if (typeof event.item_id === "string" && event.item_id) {
      return event.item_id;
    }
    if (typeof event.response_id === "string" && event.response_id) {
      return event.response_id;
    }
    this.unkeyedEventCounter += 1;
    return `unkeyed-${this.unkeyedEventCounter}`;
  }

  private dispatchFunctionCall(callId: string | undefined, name: string | undefined, argsJson: string): void {
    if (!callId || !name || this.handledCallIds.has(callId)) {
      return;
    }
    this.handledCallIds.add(callId);
    this.callbacks.onFunctionCall(callId, name, argsJson);
  }

  sendFunctionResult(callId: string, result: unknown, voiceEnabled: boolean): void {
    this.runWhenIdle(() => {
      this.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(result),
        },
      });
      this.requestResponse(voiceEnabled);
    });
  }

  appendAudio(base64Pcm16: string): void {
    this.send({ type: "input_audio_buffer.append", audio: base64Pcm16 });
  }

  sendText(text: string, voiceEnabled: boolean): void {
    this.runWhenIdle(() => {
      this.send({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      });
      this.requestResponse(voiceEnabled);
    });
  }

  /** Makes the tutor speak/type first, unprompted — used for idle nudges and the "I'm stuck" button. */
  triggerProactive(instructions: string, voiceEnabled: boolean): void {
    this.runWhenIdle(() => {
      this.send({
        type: "response.create",
        response: { instructions, output_modalities: this.modalitiesFor(voiceEnabled) },
      });
    });
  }

  /** Runs immediately if no response is in flight, otherwise waits for the current
   * one's response.done and runs then (only the most recent queued action survives). */
  private runWhenIdle(action: () => void): void {
    if (this.responseActive) {
      this.pendingAction = action;
      return;
    }
    action();
  }

  private requestResponse(voiceEnabled: boolean): void {
    this.send({ type: "response.create", response: { output_modalities: this.modalitiesFor(voiceEnabled) } });
  }

  /** Exactly one modality — requesting both "audio" and "text" together produces two parallel,
   * duplicate delta streams for the same words (see the session.update comment above). */
  private modalitiesFor(voiceEnabled: boolean): string[] {
    return voiceEnabled ? ["audio"] : ["text"];
  }

  cancelResponse(): void {
    this.send({ type: "response.cancel" });
  }

  truncateAssistantAudio(itemId: string, audioEndMs: number): void {
    this.send({ type: "conversation.item.truncate", item_id: itemId, content_index: 0, audio_end_ms: audioEndMs });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    this.outputChannel.appendLine(`> ${payload.type}`);
    this.ws.send(JSON.stringify(payload));
  }

  dispose(): void {
    this.ws?.close();
    this.ws = undefined;
  }
}
