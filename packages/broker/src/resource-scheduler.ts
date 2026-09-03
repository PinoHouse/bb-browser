import { createProtocolError } from "@bb-browser/shared";

interface QueueItem {
  sessionId: string;
  requestId?: string;
  work: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface ResourceQueue {
  active: boolean;
  lastSessionId?: string;
  order: string[];
  buckets: Map<string, QueueItem[]>;
}

const MAX_QUEUED_PER_SESSION = 100;

export class ResourceScheduler {
  private readonly resources = new Map<string, ResourceQueue>();
  private readonly sessionQueued = new Map<string, number>();
  private totalQueued = 0;

  run<T>(
    sessionId: string,
    resourceKey: string,
    work: () => Promise<T>,
    options: { requestId?: string } = {},
  ): Promise<T> {
    if (this.queuedForSession(sessionId) >= MAX_QUEUED_PER_SESSION) {
      return Promise.reject(
        createProtocolError(
          "broker_capacity_exceeded",
          "queue",
          "bb-browser 当前会话排队请求过多，请等待进行中的请求完成后重试",
          { retryable: true },
        ),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const state = this.getOrCreateResource(resourceKey);
      let bucket = state.buckets.get(sessionId);
      if (!bucket) {
        bucket = [];
        state.buckets.set(sessionId, bucket);
        state.order.push(sessionId);
      }
      bucket.push({
        sessionId,
        requestId: options.requestId,
        work,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.incrementQueued(sessionId);
      this.drain(resourceKey, state);
    });
  }

  cancelQueued(sessionId: string, requestId: string): boolean {
    for (const [resourceKey, state] of this.resources) {
      const bucket = state.buckets.get(sessionId);
      if (!bucket) {
        continue;
      }
      const index = bucket.findIndex((item) => item.requestId === requestId);
      if (index === -1) {
        continue;
      }
      const [item] = bucket.splice(index, 1);
      this.decrementQueued(sessionId);
      item.reject(
        createProtocolError(
          "request_cancelled",
          "queue",
          "bb-browser 排队请求已取消",
          { retryable: false },
        ),
      );
      if (bucket.length === 0) {
        this.removeBucket(state, sessionId);
      }
      if (!state.active && state.order.length === 0) {
        this.resources.delete(resourceKey);
      }
      return true;
    }
    return false;
  }

  queuedForSession(sessionId: string): number {
    return this.sessionQueued.get(sessionId) ?? 0;
  }

  get queuedCount(): number {
    return this.totalQueued;
  }

  private getOrCreateResource(resourceKey: string): ResourceQueue {
    let state = this.resources.get(resourceKey);
    if (!state) {
      state = {
        active: false,
        order: [],
        buckets: new Map<string, QueueItem[]>(),
      };
      this.resources.set(resourceKey, state);
    }
    return state;
  }

  private drain(resourceKey: string, state: ResourceQueue): void {
    if (state.active || state.order.length === 0) {
      return;
    }
    const item = this.takeNext(state);
    if (!item) {
      this.resources.delete(resourceKey);
      return;
    }
    state.active = true;
    this.decrementQueued(item.sessionId);
    void Promise.resolve()
      .then(item.work)
      .then(item.resolve, item.reject)
      .finally(() => {
        state.active = false;
        if (state.order.length === 0) {
          this.resources.delete(resourceKey);
        } else {
          this.drain(resourceKey, state);
        }
      });
  }

  private takeNext(state: ResourceQueue): QueueItem | undefined {
    if (state.order.length === 0) {
      return undefined;
    }
    const lastIndex = state.lastSessionId
      ? state.order.indexOf(state.lastSessionId)
      : -1;
    const nextIndex =
      lastIndex === -1 ? 0 : (lastIndex + 1) % state.order.length;
    const sessionId = state.order[nextIndex];
    const bucket = state.buckets.get(sessionId);
    const item = bucket?.shift();
    state.lastSessionId = sessionId;
    if (!bucket || bucket.length === 0) {
      this.removeBucket(state, sessionId);
    }
    return item;
  }

  private removeBucket(state: ResourceQueue, sessionId: string): void {
    state.buckets.delete(sessionId);
    const index = state.order.indexOf(sessionId);
    if (index !== -1) {
      state.order.splice(index, 1);
    }
  }

  private incrementQueued(sessionId: string): void {
    this.totalQueued += 1;
    this.sessionQueued.set(sessionId, this.queuedForSession(sessionId) + 1);
  }

  private decrementQueued(sessionId: string): void {
    this.totalQueued -= 1;
    const remaining = this.queuedForSession(sessionId) - 1;
    if (remaining <= 0) {
      this.sessionQueued.delete(sessionId);
    } else {
      this.sessionQueued.set(sessionId, remaining);
    }
  }
}
