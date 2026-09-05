# Nudge

A live, conversational AI pair-programming tutor for VS Code. v0.1 is scoped to DSA interview prep: it watches whichever file you have open, talks to you about it via voice or text, notices when you've gone quiet, and remembers which topics have tripped you up across sessions.

## Setup

1. `brew install ffmpeg` (needed for voice — see "Why ffmpeg" below). Not required for text-only use.
2. `npm install`
3. `npm run watch` (or press F5, which runs this for you)
4. Press F5 in VS Code to launch an Extension Development Host
5. Click the Nudge icon in the Activity Bar
6. Click "Set API Key" and paste an OpenAI API key with Realtime API access
7. Say what you're working on, then talk (click "Voice: off" to enable the mic) or type
8. First time you enable voice, you'll get a microphone picker (`Nudge: Select Microphone` to change it later)

Your API key is stored via VS Code's SecretStorage and only ever leaves your machine over a direct WebSocket connection from the extension host to `api.openai.com` — it's never exposed to the webview's JS context.

## Why ffmpeg (i.e. why not just use the browser mic API)

VS Code webviews — what the Nudge sidebar is built on — run in a sandbox that Chromium treats like a cross-origin iframe, and browsers only grant `getUserMedia` microphone access to a genuine top-level document. VS Code's webview host doesn't grant that exception, so no extension's webview can call the mic API directly. This is a confirmed, still-open VS Code platform limitation ([microsoft/vscode#250568](https://github.com/microsoft/vscode/issues/250568), [#113916](https://github.com/microsoft/vscode/issues/113916)) — not something fixable from extension code, and not an OS permission issue either (macOS's own mic permission grants to VS Code just fine).

The extension host, though, is a plain Node.js process, not a browser — it isn't subject to that restriction. So mic capture (`src/audioIO.ts`) shells out to `ffmpeg` (capture, via avfoundation on macOS) and `ffplay` (playback), both talking to the OS audio system directly, with the UI staying entirely in the VS Code sidebar. No external browser tab, no native Node addon (and so no Electron ABI/rebuild fragility) — just two subprocesses.

## How it works

- **Scope**: only the currently active editor tab is watched (`src/activityTracker.ts`), never the whole workspace.
- **Voice**: a single OpenAI Realtime API session (GA, `gpt-realtime-2.1` by default) per tutoring session, connected from the extension host over `ws` (`src/realtimeSession.ts`). Mic audio and speaker playback both live in the extension host (`src/audioIO.ts`) — the webview only ever sees text, never raw audio, and the API key never touches it either.
- **Idle nudges**: if there's been no edit in the watched file for `nudge.idleThresholdSeconds` (default 45s), the tutor proactively checks in.
- **"I'm stuck"**: say it out loud (handled naturally by the model) or click the button.
- **Code awareness**: the model calls a `get_editor_context` tool on demand to read your current file, cursor position, and selection — it isn't pushed on every keystroke.
- **Show me / walk me through it**: only when you explicitly ask to be shown or walked through something, the model can call `show_in_file` to write a marked example directly into your file (like writing on a whiteboard while explaining) — it's not used as a default way to answer questions or to silently hand over your actual solution.
- **Learning profile**: when the model notices a genuine conceptual struggle, it calls `record_topic_struggle`. That's stored in `globalState` (`src/learningProfile.ts`) and summarized back into future sessions' system instructions so hints adapt over time.
- **Text fallback**: the same session handles typed messages — when voice is off, responses come back as text only.

## The speaker-hearing-itself problem

Running voice through your Mac's built-in speaker/mic (no headphones) means the mic can pick up the tutor's own voice and OpenAI's voice-activity detection has no way to know that's not you — it just sees mic input and interrupts itself. This isn't a VS Code or code bug, it's acoustics (true fix would need acoustic echo cancellation, which needs capture and playback sharing one audio graph — not something two independent ffmpeg/ffplay subprocesses can do).

`nudge.autoMuteDuringPlayback` (default `true`) works around it: mic audio simply isn't forwarded to the model while the tutor is speaking (with a short grace period after the last chunk to cover ffplay's own buffering), so it can never hear itself. Trade-off: you can't barge in on it mid-sentence by voice — use the "I'm stuck" button or text input instead, or turn this setting off if you're on headphones (no speaker-to-mic path) and want true voice barge-in back.

## Notes / known rough edges (v0.1)

- OpenAI's Realtime API surface has moved fast; `nudge.realtimeModel` and `nudge.voice` are both settings so you can update them without a code change. The "Nudge: Show Debug Logs" command opens an output channel that logs every raw event in/out, which is the fastest way to spot a protocol drift.
- `input_audio_transcription` is configured with `gpt-4o-mini-transcribe`; if OpenAI renames the completion event, spoken input still works, only the on-screen transcript of your own speech might not render — check the debug log.
- Voice is macOS-first (avfoundation). Linux falls back to the default PulseAudio input, untested. Windows isn't wired up yet — dshow selects devices by name rather than index, which doesn't fit the current device-picker flow, so voice reports "unsupported" there for now and falls back to text.
- Barge-in (interrupting the tutor mid-sentence) relies on `turn_detection.interrupt_response` to stop the response server-side, plus killing and respawning the `ffplay` process locally — the only way to stop already-buffered audio instantly — and estimates how much audio you actually heard from bytes written rather than a precise playback clock. Close enough for conversation flow; not sample-accurate.
- Chat bubbles are keyed off each event's `item_id`/`response_id`, never a shared fallback constant — important since overlapping responses (e.g. right around a barge-in) previously collapsed into the same bubble and produced garbled, interleaved text.
- Generalizing beyond DSA prep later should mostly mean swapping `src/systemPrompt.ts` and adding a mode setting — the rest of the architecture (activity tracking, realtime session, learning profile, tool-calling, native audio) isn't DSA-specific.
