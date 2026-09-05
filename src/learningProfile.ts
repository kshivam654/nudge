import * as vscode from "vscode";
import { LearningProfileData, TopicStruggle } from "./types";

const STORAGE_KEY = "nudge.learningProfile";
const MAX_NOTES_PER_TOPIC = 5;

/**
 * Cross-workspace record of which DSA topics/patterns the user has struggled
 * with over time, built from the model's own `record_topic_struggle` tool calls.
 */
export class LearningProfile {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private load(): LearningProfileData {
    return this.context.globalState.get<LearningProfileData>(STORAGE_KEY, { topics: {} });
  }

  private async save(data: LearningProfileData): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, data);
  }

  async recordStruggle(topic: string, note: string): Promise<void> {
    const data = this.load();
    const slug = topic.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 60);
    if (!slug) {
      return;
    }
    const existing: TopicStruggle = data.topics[slug] ?? { count: 0, lastSeen: "", notes: [] };
    existing.count += 1;
    existing.lastSeen = new Date().toISOString();
    existing.notes = [...existing.notes, note].slice(-MAX_NOTES_PER_TOPIC);
    data.topics[slug] = existing;
    await this.save(data);
  }

  async reset(): Promise<void> {
    await this.save({ topics: {} });
  }

  /** A short paragraph summarizing weak topics, meant to be injected into the tutor's system instructions. */
  getSummaryForPrompt(limit = 4): string {
    const data = this.load();
    const entries = Object.entries(data.topics).sort((a, b) => b[1].count - a[1].count);
    if (entries.length === 0) {
      return "No prior struggle history yet — this looks like a fresh start, so don't assume any weak areas.";
    }
    const lines = entries.slice(0, limit).map(([topic, struggle]) => {
      const latestNote = struggle.notes[struggle.notes.length - 1];
      return `- ${topic} (struggled ${struggle.count}x): ${latestNote}`;
    });
    return [
      "Based on past sessions, the user has historically struggled with these topics — lean toward more scaffolded, step-by-step hints when these come up, without calling it out explicitly unless it helps:",
      ...lines,
    ].join("\n");
  }
}
