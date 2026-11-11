import { describe, expect, test } from "bun:test"
import { Interrupted, createInterrupt, interruptReasonOf, releasesClaim } from "../src/interrupt.ts"

describe("interrupt", () => {
  test("a fresh token is not aborted and has no reason", () => {
    const token = createInterrupt()
    expect(token.signal.aborted).toBe(false)
    expect(interruptReasonOf(token.signal)).toBeNull()
  })

  test("the reason travels with the signal", () => {
    const token = createInterrupt()
    token.interrupt("user")
    expect(token.signal.aborted).toBe(true)
    expect(token.signal.reason).toBeInstanceOf(Interrupted)
    expect(interruptReasonOf(token.signal)).toBe("user")
  })

  test("the first reason wins", () => {
    const token = createInterrupt()
    token.interrupt("shutdown")
    token.interrupt("user")
    expect(interruptReasonOf(token.signal)).toBe("shutdown")
  })

  test("an abort without a reason is an error, never a default", () => {
    const controller = new AbortController()
    controller.abort()
    expect(() => interruptReasonOf(controller.signal)).toThrow("without an InterruptReason")
    expect(() => interruptReasonOf(AbortSignal.abort("user"))).toThrow("without an InterruptReason")
  })

  test("a user interrupt releases the recovery claim and a shutdown keeps it", () => {
    expect(releasesClaim("user")).toBe(true)
    expect(releasesClaim("shutdown")).toBe(false)
  })

  test("listeners see the reason", async () => {
    const token = createInterrupt()
    const seen = new Promise((resolve) =>
      token.signal.addEventListener("abort", () => resolve(interruptReasonOf(token.signal))),
    )
    token.interrupt("user")
    expect(await seen).toBe("user")
  })
})
