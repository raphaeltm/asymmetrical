import type { Message, Intent, DriftConfig, DriftResult } from './types.js';
import type { DriftProvider } from './provider.js';
import { MessageWindow } from './window.js';

const DEFAULT_CHECK_INTERVAL = 5;
const DEFAULT_THRESHOLD = 0.6;

export class DriftDetector {
  private readonly window: MessageWindow;
  private readonly provider: DriftProvider;
  private readonly intent: Intent;
  private readonly checkInterval: number;
  private readonly threshold: number;
  private readonly results: DriftResult[] = [];
  private _messagesSinceLastCheck = 0;

  onDrift: ((result: DriftResult) => void) | null = null;
  onCheck: ((result: DriftResult) => void) | null = null;

  constructor(config: DriftConfig, provider: DriftProvider, intent: Intent) {
    this.window = new MessageWindow(config);
    this.provider = provider;
    this.intent = intent;
    this.checkInterval = config.checkInterval ?? DEFAULT_CHECK_INTERVAL;
    this.threshold = config.threshold ?? DEFAULT_THRESHOLD;
  }

  async push(message: Message): Promise<DriftResult | null> {
    this.window.push(message);
    this._messagesSinceLastCheck++;

    if (this._messagesSinceLastCheck >= this.checkInterval) {
      return this.check();
    }

    return null;
  }

  async check(): Promise<DriftResult> {
    this._messagesSinceLastCheck = 0;
    const messages = this.window.getMessages();
    const result = await this.provider.check(this.intent, messages);

    // Override isDrifting based on threshold
    result.isDrifting = result.probability >= this.threshold;
    result.messageCount = messages.length;
    result.windowTokenEstimate = this.window.getTokenEstimate();
    result.checkedAt = Date.now();

    this.results.push(result);

    this.onCheck?.(result);

    if (result.isDrifting) {
      this.onDrift?.(result);
    }

    return result;
  }

  history(): DriftResult[] {
    return [...this.results];
  }
}
