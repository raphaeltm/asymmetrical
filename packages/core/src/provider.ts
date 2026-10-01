import type { Message, Intent, DriftResult } from './types.js';

export interface DriftProvider {
  check(intent: Intent, messages: Message[]): Promise<DriftResult>;
}
