import { ChildProcessWithoutNullStreams, spawn } from "child_process";

/**
 * Native microphone capture and speaker playback for the extension host.
 *
 * VS Code webviews cannot call getUserMedia — they run in a browser sandbox
 * that only grants microphone access to a genuine top-level document, and
 * VS Code's webview host doesn't grant that (see microsoft/vscode#250568,
 * #113916 — an open platform limitation, not something an extension can
 * unlock). The extension host itself is a plain Node.js process, not a
 * browser, so it isn't subject to that restriction: we shell out to ffmpeg
 * (capture) and ffplay (playback), which talk to the OS audio system
 * directly. This keeps the whole UI in the VS Code sidebar with no
 * external browser tab.
 *
 * macOS (avfoundation) is fully supported. Linux best-effort defaults to
 * the system's default PulseAudio input. Windows isn't wired up yet —
 * dshow devices are selected by name rather than index, which doesn't fit
 * the same device-index flow; voice falls back to unsupported there for now.
 */

export interface AudioDevice {
  index: number;
  name: string;
}

const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2; // 16-bit PCM
const BYTES_PER_MS = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000;

export function checkFfmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", ["-version"]);
    proc.on("error", () => resolve(false));
    proc.on("exit", (code) => resolve(code === 0));
  });
}

export function listMicDevices(): Promise<AudioDevice[]> {
  if (process.platform !== "darwin") {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]);
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", () => resolve([]));
    proc.on("close", () => resolve(parseAvfoundationDevices(stderr)));
  });
}

function parseAvfoundationDevices(stderr: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  let inAudioSection = false;
  for (const line of stderr.split("\n")) {
    if (line.includes("AVFoundation audio devices")) {
      inAudioSection = true;
      continue;
    }
    if (!inAudioSection) {
      continue;
    }
    const match = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (match) {
      devices.push({ index: Number(match[1]), name: match[2] });
    } else if (!line.includes("AVFoundation")) {
      break;
    }
  }
  return devices;
}

function captureArgs(deviceIndex: number): string[] {
  const common = ["-hide_banner", "-loglevel", "error", "-ar", String(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "pipe:1"];
  if (process.platform === "darwin") {
    return ["-f", "avfoundation", "-i", `:${deviceIndex}`, ...common];
  }
  // Best-effort Linux default input; untested on Windows (dshow needs a device name, not an index).
  return ["-f", "pulse", "-i", "default", ...common];
}

/** Streams raw 24kHz mono PCM16 chunks from the mic, base64-encoded, ready for
 * the Realtime API's input_audio_buffer.append. */
export class MicCapture {
  private proc: ChildProcessWithoutNullStreams | undefined;

  constructor(private readonly onChunk: (base64: string) => void, private readonly onError: (message: string) => void) {}

  start(deviceIndex: number): void {
    if (process.platform === "win32") {
      this.onError("Microphone capture isn't supported on Windows yet — use text chat instead.");
      return;
    }
    this.proc = spawn("ffmpeg", captureArgs(deviceIndex));
    this.proc.stdout.on("data", (chunk: Buffer) => this.onChunk(chunk.toString("base64")));
    this.proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        this.onError(`ffmpeg (mic): ${text}`);
      }
    });
    this.proc.on("error", (err) => this.onError(`Failed to start microphone capture: ${err.message}`));
  }

  stop(): void {
    this.proc?.kill("SIGTERM");
    this.proc = undefined;
  }
}

/** How much longer to consider playback "active" after the last chunk is written
 * before unmuting the mic — covers ffplay's own internal audio buffer latency,
 * so auto-mute doesn't unmute while the tail of a sentence is still audible. */
const PLAYBACK_TAIL_GRACE_MS = 600;

/** Plays back 24kHz mono PCM16 chunks as they arrive from the Realtime API. */
export class SpeakerPlayback {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private bytesWrittenForCurrentItem = 0;
  private isPlaying = false;
  private stopPlayingTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onError: (message: string) => void) {}

  /** True while the tutor's voice is (or was very recently) audibly playing —
   * used to auto-mute the mic and avoid it hearing its own speaker output. */
  get playing(): boolean {
    return this.isPlaying;
  }

  private ensureProcess(): void {
    if (this.proc) {
      return;
    }
    this.proc = spawn("ffplay", [
      "-hide_banner",
      "-loglevel",
      "error",
      // Without -nostats, ffplay writes its live status bar (cursor-control
      // escape codes) to stderr regardless of -loglevel — -nodisp doesn't
      // suppress it, and the escape bytes survive a plain .trim() as "content".
      "-nostats",
      "-nodisp",
      "-f",
      "s16le",
      "-ar",
      String(SAMPLE_RATE),
      // Newer ffmpeg/ffplay builds (9.x) dropped the raw-PCM demuxer's old
      // -ac/-channels/-channel_layout aliases in favor of -ch_layout; -ac
      // fails with "Option not found" there even though it's still valid
      // for ffmpeg's own *output* options (used in captureArgs above).
      "-ch_layout",
      "mono",
      "-i",
      "pipe:0",
    ]);
    this.proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        this.onError(`ffplay: ${text}`);
      }
    });
    this.proc.on("error", (err) => this.onError(`Failed to start audio playback: ${err.message}`));
    this.proc.stdin.on("error", () => {
      // Writing after a kill (e.g. mid-barge-in) raises EPIPE — harmless, the process is gone.
    });
  }

  write(base64: string): void {
    this.ensureProcess();
    this.isPlaying = true;
    this.clearStopTimer();
    const buffer = Buffer.from(base64, "base64");
    this.bytesWrittenForCurrentItem += buffer.length;
    this.proc?.stdin.write(buffer);
  }

  /** Call once no more audio is coming for the current response (e.g.
   * response.output_audio.done, or response.done as a safety net). Keeps
   * `playing` true for a short grace period rather than flipping it off
   * immediately — see PLAYBACK_TAIL_GRACE_MS. Safe to call more than once. */
  markResponseAudioDone(): void {
    this.clearStopTimer();
    this.stopPlayingTimer = setTimeout(() => {
      this.isPlaying = false;
      this.stopPlayingTimer = undefined;
    }, PLAYBACK_TAIL_GRACE_MS);
  }

  /** Only a hard kill actually stops audio that's already buffered downstream —
   * there's no player IPC to "flush" mid-stream. Returns how many ms of the
   * current item had been written, for conversation.item.truncate. */
  stopAndFlush(): number {
    const elapsedMs = Math.round(this.bytesWrittenForCurrentItem / BYTES_PER_MS);
    this.bytesWrittenForCurrentItem = 0;
    this.isPlaying = false;
    this.clearStopTimer();
    this.proc?.kill("SIGKILL");
    this.proc = undefined;
    return elapsedMs;
  }

  resetForNewItem(): void {
    this.bytesWrittenForCurrentItem = 0;
  }

  private clearStopTimer(): void {
    if (this.stopPlayingTimer) {
      clearTimeout(this.stopPlayingTimer);
      this.stopPlayingTimer = undefined;
    }
  }

  dispose(): void {
    this.isPlaying = false;
    this.clearStopTimer();
    this.proc?.kill("SIGKILL");
    this.proc = undefined;
  }
}
