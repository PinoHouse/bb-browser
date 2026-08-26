import { randomUUID } from "node:crypto";
import { createProtocolError } from "@bb-browser/shared";

interface ActiveLease {
  sessionId: string;
  tabId: number;
  leaseId: string;
  expiresAt: number;
}

interface LeaseWaiter {
  sessionId: string;
  tabId: number;
  deadlineAt: number;
  timer: NodeJS.Timeout;
  resolve: (lease: { leaseId: string; tabId: number }) => void;
  reject: (error: unknown) => void;
}

const MAX_LEASE_MS = 120_000;

export class LeaseManager {
  private readonly active = new Map<number, ActiveLease>();
  private readonly waiting = new Map<number, LeaseWaiter[]>();

  acquire(
    sessionId: string,
    tabId: number,
    deadlineAt: number,
  ): Promise<{ leaseId: string; tabId: number }> {
    const now = Date.now();
    if (deadlineAt <= now) {
      return Promise.reject(this.timeoutError(tabId));
    }
    this.purgeExpired(tabId, now);
    const current = this.active.get(tabId);
    if (!current) {
      return Promise.resolve(this.grant(sessionId, tabId, deadlineAt, now));
    }
    if (current.sessionId === sessionId) {
      return Promise.resolve({ leaseId: current.leaseId, tabId });
    }

    return new Promise((resolve, reject) => {
      const waiter: LeaseWaiter = {
        sessionId,
        tabId,
        deadlineAt,
        timer: setTimeout(() => {
          this.removeWaiter(waiter);
          reject(this.timeoutError(tabId));
        }, Math.max(1, deadlineAt - now)),
        resolve,
        reject,
      };
      const queue = this.waiting.get(tabId) ?? [];
      queue.push(waiter);
      this.waiting.set(tabId, queue);
    });
  }

  assertAccess(
    sessionId: string,
    tabId: number,
    leaseId?: string,
  ): void {
    this.purgeExpired(tabId);
    const current = this.active.get(tabId);
    if (!current) {
      if (leaseId) {
        throw this.timeoutError(tabId);
      }
      return;
    }
    if (current.sessionId !== sessionId || current.leaseId !== leaseId) {
      throw this.timeoutError(tabId);
    }
  }

  release(sessionId: string, leaseId: string): void {
    for (const [tabId, current] of this.active) {
      if (current.leaseId !== leaseId) {
        continue;
      }
      if (current.sessionId !== sessionId) {
        throw createProtocolError(
          "tab_not_owned",
          "cleanup",
          "不能释放其他会话的标签页租约",
          { retryable: false },
        );
      }
      this.active.delete(tabId);
      this.grantNext(tabId);
      return;
    }
  }

  releaseSession(sessionId: string): void {
    for (const [tabId, queue] of this.waiting) {
      const retained: LeaseWaiter[] = [];
      for (const waiter of queue) {
        if (waiter.sessionId === sessionId) {
          clearTimeout(waiter.timer);
          waiter.reject(
            createProtocolError(
              "session_expired",
              "cleanup",
              "会话结束，标签页租约请求已取消",
              { retryable: false },
            ),
          );
        } else {
          retained.push(waiter);
        }
      }
      if (retained.length === 0) {
        this.waiting.delete(tabId);
      } else {
        this.waiting.set(tabId, retained);
      }
    }

    for (const [tabId, current] of this.active) {
      if (current.sessionId === sessionId) {
        this.active.delete(tabId);
        this.grantNext(tabId);
      }
    }
  }

  get activeCount(): number {
    for (const tabId of this.active.keys()) {
      this.purgeExpired(tabId);
    }
    return this.active.size;
  }

  private grant(
    sessionId: string,
    tabId: number,
    deadlineAt: number,
    now = Date.now(),
  ): { leaseId: string; tabId: number } {
    const lease: ActiveLease = {
      sessionId,
      tabId,
      leaseId: randomUUID(),
      expiresAt: Math.min(deadlineAt, now + MAX_LEASE_MS),
    };
    this.active.set(tabId, lease);
    return { leaseId: lease.leaseId, tabId };
  }

  private grantNext(tabId: number): void {
    if (this.active.has(tabId)) {
      return;
    }
    const queue = this.waiting.get(tabId);
    if (!queue) {
      return;
    }
    while (queue.length > 0) {
      const waiter = queue.shift()!;
      clearTimeout(waiter.timer);
      const now = Date.now();
      if (waiter.deadlineAt <= now) {
        waiter.reject(this.timeoutError(tabId));
        continue;
      }
      waiter.resolve(
        this.grant(waiter.sessionId, tabId, waiter.deadlineAt, now),
      );
      break;
    }
    if (queue.length === 0) {
      this.waiting.delete(tabId);
    }
  }

  private purgeExpired(tabId: number, now = Date.now()): void {
    const current = this.active.get(tabId);
    if (current && current.expiresAt <= now) {
      this.active.delete(tabId);
      this.grantNext(tabId);
    }
  }

  private removeWaiter(waiter: LeaseWaiter): void {
    const queue = this.waiting.get(waiter.tabId);
    if (!queue) {
      return;
    }
    const index = queue.indexOf(waiter);
    if (index !== -1) {
      queue.splice(index, 1);
    }
    if (queue.length === 0) {
      this.waiting.delete(waiter.tabId);
    }
  }

  private timeoutError(tabId: number) {
    return createProtocolError(
      "tab_lease_timeout",
      "queue",
      `标签页 ${tabId} 正由另一个工作流使用`,
    );
  }
}
