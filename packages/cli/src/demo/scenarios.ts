/** Every scenario `--demo` can play: the CLI's showcase first, then the step-loop scenarios from core, numbered. */
import { families } from "../../../core/test/scenarios/index.ts"
import type { Scenario } from "../../../core/test/scenarios/script.ts"
import { showcase } from "./showcase.ts"

export interface DemoScenario {
  readonly number: number
  /** Kebab-case name, from the title. */
  readonly name: string
  readonly family: string
  readonly scenario: Scenario
}

const listed: [string, readonly Scenario[]][] = [["Showcase", showcase], ...Object.entries(families)]

export const demoScenarios: readonly DemoScenario[] = listed
  .flatMap(([family, scenarios]) => scenarios.map((scenario) => ({ family, scenario })))
  .map((entry, index) => ({ ...entry, number: index + 1, name: slug(entry.scenario.title) }))

/** Finds a scenario by name, number or unique name prefix. */
export function findScenario(query: string): DemoScenario | null {
  const wanted = query.trim().toLowerCase()
  if (/^\d+$/.test(wanted)) return demoScenarios.find((entry) => entry.number === Number(wanted)) ?? null
  const exact = demoScenarios.find((entry) => entry.name === wanted)
  if (exact !== undefined) return exact
  const prefixed = demoScenarios.filter((entry) => entry.name.startsWith(wanted))
  return prefixed.length === 1 ? prefixed[0]! : null
}

/** The `--demo list` text. */
export function listScenarios(): string {
  const out: string[] = []
  let family = ""
  for (const entry of demoScenarios) {
    if (entry.family !== family) {
      family = entry.family
      out.push(`${out.length === 0 ? "" : "\n"}${family}`)
    }
    out.push(`  ${String(entry.number).padStart(2)}  ${entry.name}`)
  }
  return `${out.join("\n")}\n`
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}
