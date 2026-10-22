// The little of the VS Code API that ReviewState uses, so `npm run e2e` can drive it from Node.
export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  readonly event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter(l => l !== listener)) };
  };
  fire(e: T): void {
    this.listeners.forEach(l => l(e));
  }
  dispose(): void {
    this.listeners = [];
  }
}

export const workspace = {
  getConfiguration: () => ({ get: <V>(_key: string, fallback?: V) => fallback }),
};
