// Minimal ambient declaration for the `bun:test` module so tsc and the IDE
// can resolve `import { describe, expect, test, beforeAll } from 'bun:test'`.
//
// The runtime under `bun test` provides the real implementation; this only
// satisfies the type-checker. It is deliberately permissive (matchers accept
// `unknown`) so assertion values like `await response.json()` do not trip
// overload-resolution quirks. @cloudflare/workers-types remains the sole
// source of global types, so this avoids pulling in bun's competing globals.
declare module 'bun:test' {
  type TestFn = () => void | Promise<void>
  const describe: (name: string, fn: () => void) => void
  const test: (name: string, fn: TestFn) => void
  const beforeAll: (fn: TestFn) => void
  const expect: <T>(actual: T) => Matchers<T>
  interface Matchers<T> {
    toEqual(expected: unknown): void
    toBe(expected: unknown): void
    toBeNull(): void
    toContain(expected: unknown): void
    toBeGreaterThan(expected: number): void
    toMatch(expected: unknown): void
    toBeUndefined(): void
    readonly not: Matchers<T>
  }
}
