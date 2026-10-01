/**
 * Session manager — tracks active monitoring sessions.
 *
 * Each session has its own DriftDetector instance, message log,
 * and drift result history.
 */

import { DriftDetector, type Message, type Intent, type DriftResult, type DriftConfig } from '@asymmetrical/core';
import type { DriftProvider } from '@asymmetrical/core';

export interface Session {
  id: string;
  intent: Intent;
  detector: DriftDetector;
  messages: Message[];
  createdAt: number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private provider: DriftProvider;
  private defaultConfig: DriftConfig;

  /** Called when any session gets a drift check result */
  onResult: ((sessionId: string, result: DriftResult) => void) | null = null;

  constructor(provider: DriftProvider, defaultConfig: DriftConfig = {}) {
    this.provider = provider;
    this.defaultConfig = defaultConfig;
  }

  create(id: string, intent: Intent, config?: Partial<DriftConfig>): Session {
    const mergedConfig = { ...this.defaultConfig, ...config };
    const detector = new DriftDetector(mergedConfig, this.provider, intent);

    detector.onCheck = (result) => {
      this.onResult?.(id, result);
    };

    const session: Session = {
      id,
      intent,
      detector,
      messages: [],
      createdAt: Date.now(),
    };

    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  async pushMessage(sessionId: string, message: Message): Promise<DriftResult | null> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.messages.push(message);
    return session.detector.push(message);
  }

  async forceCheck(sessionId: string): Promise<DriftResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return session.detector.check();
  }

  list(): Array<{ id: string; intent: Intent; messageCount: number; createdAt: number; lastResult?: DriftResult }> {
    return Array.from(this.sessions.values()).map((s) => {
      const history = s.detector.history();
      return {
        id: s.id,
        intent: s.intent,
        messageCount: s.messages.length,
        createdAt: s.createdAt,
        lastResult: history.length > 0 ? history[history.length - 1] : undefined,
      };
    });
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }
}
