/** Runs tasks one after another, in call order. */
export class Lane {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** Share one in-flight promise between concurrent callers. */
export class Single<T> {
  private inflight?: Promise<T>;
  run(task: () => Promise<T>): Promise<T> {
    this.inflight ??= task().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }
}
