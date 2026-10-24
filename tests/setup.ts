/** Provide a browser-shaped `localStorage` for the Node test environment. */
class MemoryStorage implements Storage {
  #entries = new Map<string, string>()
  get length(): number { return this.#entries.size }
  clear(): void { this.#entries.clear() }
  getItem(key: string): string | null { return this.#entries.get(key) ?? null }
  key(index: number): string | null { return [...this.#entries.keys()][index] ?? null }
  removeItem(key: string): void { this.#entries.delete(key) }
  setItem(key: string, value: string): void { this.#entries.set(key, String(value)) }
}

if (globalThis.localStorage === undefined) {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true, writable: true })
}
