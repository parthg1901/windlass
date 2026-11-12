import { describe, expect, test } from "bun:test"
import { CallCancelled, Interrupted, callStopReasonOf, createCallStop, createInterrupt, interruptReasonOf, releasesClaim } from "../src/interrupt.ts"

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

  describe("the abort token of one tool call", () => {
    test("it is not aborted while neither the execution nor the call is stopped", () => {
      const stop = createCallStop(createInterrupt().signal)
      expect(stop.signal.aborted).toBe(false)
      expect(callStopReasonOf(stop.signal)).toBeNull()
    })

    test("stopping the call aborts its signal with a reason that says so, and leaves the execution alone", () => {
      const execution = createInterrupt()
      const first = createCallStop(execution.signal)
      const second = createCallStop(execution.signal)
      first.cancel()
      expect(first.signal.reason).toBeInstanceOf(CallCancelled)
      expect(callStopReasonOf(first.signal)).toBe("call")
      expect(execution.signal.aborted).toBe(false)
      expect(second.signal.aborted).toBe(false)
      // It is not an interrupt: code that asks for an execution's reason is told that it is asking the wrong signal.
      expect(() => interruptReasonOf(first.signal)).toThrow("without an InterruptReason")
    })

    test("an interrupt of the execution reaches every call with the execution's reason", () => {
      const execution = createInterrupt()
      const stops = [createCallStop(execution.signal), createCallStop(execution.signal)]
      execution.interrupt("shutdown")
      expect(stops.map((stop) => callStopReasonOf(stop.signal))).toEqual(["shutdown", "shutdown"])
    })

    test("the first abort wins, either way round", () => {
      const execution = createInterrupt()
      const stopped = createCallStop(execution.signal)
      stopped.cancel()
      execution.interrupt("user")
      expect(callStopReasonOf(stopped.signal)).toBe("call")

      const interrupted = createCallStop(execution.signal)
      expect(callStopReasonOf(interrupted.signal)).toBe("user")
      interrupted.cancel()
      expect(callStopReasonOf(interrupted.signal)).toBe("user")
    })

    test("a released token no longer follows the execution", () => {
      const execution = createInterrupt()
      const stop = createCallStop(execution.signal)
      stop.release()
      execution.interrupt("user")
      expect(stop.signal.aborted).toBe(false)
    })

    test("an abort without a reason is still an error", () => {
      expect(() => callStopReasonOf(AbortSignal.abort("user"))).toThrow("without an InterruptReason")
    })
  })
})
