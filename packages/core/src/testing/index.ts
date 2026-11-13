/**
 * Helpers for tests of code that is built on core: a scripted provider that
 * streams whatever a test tells it to, and `waitFor`, which waits for a
 * condition instead of an amount of time. Import them from
 * `@windlass/core/testing`; they are not part of the main entry point.
 */
export * from "./fake-provider.ts"
export * from "./wait.ts"
