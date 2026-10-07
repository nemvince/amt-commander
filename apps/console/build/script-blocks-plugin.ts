/**
 * Loads `script-blocks.json` as a plain object literal instead of the JSON
 * module Vite emits.
 *
 * Two reasons, both measured on the large tier:
 *
 * - Size: Vite's JSON transform wraps the data in a property read on a hoisted
 *   object, and the escaping it leaves behind costs ~235 B gzipped more than a
 *   plain literal on this 66 KB payload.
 * - Dead-code elimination: a `.json` module reaching the graph through an
 *   unreferenced importer is kept whole, so a tier without `FEAT_Scripting` used
 *   to ship the entire 66 KB library (11.3 KB gzipped). Emitting the data as an
 *   ordinary ES module export lets the bundler drop it with its importer.
 *
 * The `.json` file stays the single source of truth: this only changes how it
 * enters the module graph, so there is no generated file to fall out of date.
 */
import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'

const VIRTUAL_ID = 'virtual:script-blocks'
const RESOLVED = '\0' + VIRTUAL_ID

export interface ScriptBlocksPluginOptions {
  /** Absolute path of the JSON file to expose. */
  file: string
}

export function scriptBlocksPlugin(options: ScriptBlocksPluginOptions): Plugin {
  return {
    name: 'meshcommander:script-blocks',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED : null
    },
    load(id) {
      if (id !== RESOLVED) return null
      // Watch the source so editing the JSON invalidates the module.
      this.addWatchFile(options.file)
      // Parse then re-emit: this drops the file's own whitespace and fails loudly
      // on malformed JSON rather than emitting an object literal that throws at
      // runtime.
      const parsed = JSON.parse(readFileSync(options.file, 'utf8')) as { blocks: unknown }
      return `export default ${JSON.stringify(parsed.blocks)}`
    },
  }
}
