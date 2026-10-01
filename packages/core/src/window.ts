import type { Message, DriftConfig } from './types.js';

const DEFAULT_WINDOW_SIZE = 30;
const DEFAULT_MAX_TOKEN_BUDGET = 24000;
const CHARS_PER_TOKEN = 4;

export class MessageWindow {
  private messages: Message[] = [];
  private readonly windowSize: number;
  private readonly maxTokenBudget: number;

  constructor(config: DriftConfig = {}) {
    this.windowSize = config.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.maxTokenBudget = config.maxTokenBudget ?? DEFAULT_MAX_TOKEN_BUDGET;
  }

  push(message: Message): void {
    this.messages.push(message);

    // Enforce window size limit — always keep the first message (original prompt)
    if (this.messages.length > this.windowSize) {
      const first = this.messages[0];
      this.messages = [first, ...this.messages.slice(-(this.windowSize - 1))];
    }

    // Enforce token budget — drop oldest messages (except first) until under budget
    while (
      this.messages.length > 1 &&
      this.estimateTokens(this.messages) > this.maxTokenBudget
    ) {
      this.messages.splice(1, 1);
    }
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  getTokenEstimate(): number {
    return this.estimateTokens(this.messages);
  }

  private estimateTokens(messages: Message[]): number {
    let totalChars = 0;
    for (const msg of messages) {
      totalChars += msg.content.length;
    }
    return Math.ceil(totalChars / CHARS_PER_TOKEN);
  }
}
