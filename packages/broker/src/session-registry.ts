import { randomUUID } from "node:crypto";
import { createProtocolError } from "@bb-browser/shared";

export interface SessionRecord {
  clientId: string;
  sessionId: string;
  createdAt: number;
  lastSeenAt: number;
  connected: boolean;
  ownedTabs: Set<number>;
  referencedTabs: Set<number>;
  defaultTabId?: number;
}

export interface SessionRegistryOptions {
  recoveryWindowMs: number;
  idleTimeoutMs?: number;
  maxSessions?: number;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly idleTimeoutMs: number;
  private readonly maxSessions: number;

  constructor(private readonly options: SessionRegistryOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 300_000;
    this.maxSessions = options.maxSessions ?? 32;
  }

  create(clientId: string): SessionRecord {
    this.expire();
    if (this.sessions.size >= this.maxSessions) {
      throw createProtocolError(
        "broker_unavailable",
        "connect",
        "bb-browser Broker 会话数已达上限",
      );
    }
    const now = Date.now();
    const record: SessionRecord = {
      clientId,
      sessionId: randomUUID(),
      createdAt: now,
      lastSeenAt: now,
      connected: true,
      ownedTabs: new Set<number>(),
      referencedTabs: new Set<number>(),
    };
    this.sessions.set(record.sessionId, record);
    return record;
  }

  resume(sessionId: string, clientId: string): SessionRecord | null {
    const record = this.sessions.get(sessionId);
    const now = Date.now();
    if (
      !record ||
      record.connected ||
      record.clientId !== clientId ||
      now - record.lastSeenAt > this.options.recoveryWindowMs
    ) {
      return null;
    }
    record.connected = true;
    record.lastSeenAt = now;
    return record;
  }

  touch(sessionId: string): void {
    const record = this.require(sessionId);
    record.lastSeenAt = Date.now();
  }

  disconnect(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return;
    }
    record.connected = false;
    record.lastSeenAt = Date.now();
  }

  expire(now = Date.now()): SessionRecord[] {
    const expired: SessionRecord[] = [];
    for (const [sessionId, record] of this.sessions) {
      const idleFor = now - record.lastSeenAt;
      if (
        idleFor > this.idleTimeoutMs ||
        (!record.connected && idleFor > this.options.recoveryWindowMs)
      ) {
        this.sessions.delete(sessionId);
        expired.push(record);
      }
    }
    return expired;
  }

  require(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw createProtocolError(
        "session_expired",
        "queue",
        "bb-browser 会话不存在或已过期",
        { retryable: false },
      );
    }
    return record;
  }

  recordOwnedTab(sessionId: string, tabId: number): void {
    const record = this.require(sessionId);
    record.ownedTabs.add(tabId);
    record.referencedTabs.add(tabId);
    record.defaultTabId = tabId;
  }

  recordReference(sessionId: string, tabId: number): void {
    const record = this.require(sessionId);
    record.referencedTabs.add(tabId);
  }

  setDefaultTab(sessionId: string, tabId: number): void {
    const record = this.require(sessionId);
    record.referencedTabs.add(tabId);
    record.defaultTabId = tabId;
  }

  defaultTab(sessionId: string): number | undefined {
    return this.require(sessionId).defaultTabId;
  }

  forgetTab(tabId: number): void {
    for (const record of this.sessions.values()) {
      record.ownedTabs.delete(tabId);
      record.referencedTabs.delete(tabId);
      if (record.defaultTabId === tabId) {
        record.defaultTabId = undefined;
      }
    }
  }

  ownedTabs(sessionId: string): number[] {
    return [...this.require(sessionId).ownedTabs];
  }

  get activeCount(): number {
    return [...this.sessions.values()].filter((record) => record.connected)
      .length;
  }

  get size(): number {
    return this.sessions.size;
  }
}
