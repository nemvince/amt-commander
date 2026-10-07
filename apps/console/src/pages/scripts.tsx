import { Fragment } from 'preact'
import '../styles/scripts.css'
import { useEffect, useRef, useState } from 'preact/hooks'
import { FEAT_FileSaver, FEAT_ScriptingEditor } from '../features'
import { S } from '../strings'
import { getStack } from '../state/device'
import { Dialog } from '../ui/dialog'
import { format } from '../lib/amt-stack'
import {
  SCRIPT_BLOCKS,
  blocksToScript,
  instantiateBlock,
  scriptCompile,
  scriptDecompile,
  scriptSetup,
  type ScriptBlockInstance,
  type ScriptRunner,
  type ScriptVar,
} from '../lib/scripting'

/**
 * Script Editor, ported from the `#p20` view and its `{Scripting-Editor}` region
 * (index.html:1181-1224, 11995-12485).
 *
 * Two views over the same script: the block builder (a library on the left, the
 * script's blocks on the right) and the plain text editor. The builder rewrites the
 * text on every change, so `scriptText` is always the single source of truth that
 * gets compiled.
 */

/** A `.mescript` file, exactly the shape index.html:12475 writes. */
interface MescriptFile {
  scriptText?: string
  mescript?: string
  blocks?: Record<string, ScriptBlockInstance>
  scriptBlocks?: ScriptBlockInstance[]
}

const START_VARS = { _interactive: 1, _mode: 'Firmware' }

/** Blocks whose name starts with `_` are structural and never shown in the picker. */

function varText(v: ScriptVar): string {
  if (v.type == 4 && String(v.value ?? '').length > 0) return '*****'
  if (v.type == 3) return v.values?.[String(v.value)] ?? String(v.value ?? '')
  if (v.type == 6) return v.value ? format(S.scriptBinaryFile, String(v.value).length) : S.scriptNotSet
  return String(v.value ?? '')
}

export function ScriptsPage() {
  const [list, setList] = useState<ScriptBlockInstance[]>([])
  const [scriptText, setScriptText] = useState('')
  const [builder, setBuilder] = useState(!!FEAT_ScriptingEditor)
  const [filter, setFilter] = useState('')
  const [status, setStatus] = useState<string>(S.scriptStoppedNoScript)
  const [lines, setLines] = useState<string[]>([])
  const [vars, setVars] = useState<Record<string, unknown>>({})
  const [highlight, setHighlight] = useState(-1)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(-1)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [confirmNew, setConfirmNew] = useState(false)
  const [prompt, setPrompt] = useState<{ title: string; content: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const runner = useRef<ScriptRunner | null>(null)

  // The runner owns a timer; it must not outlive the page.
  useEffect(() => () => runner.current?.stop(), [])

  const refresh = (r: ScriptRunner) => {
    const state = r.state === 0 ? S.scriptStopped : r.state === 1 ? S.scriptRunning : S.scriptPaused
    setStatus(r.state > 0 ? (state + ', ' + r.ip + ' : ' + scriptDecompile(r.script, r.ip)).slice(0, 64) : state)
    const visible: Record<string, unknown> = {}
    for (const k in r.variables) if (!k.startsWith('__')) visible[k] = r.variables[k]
    setVars(visible)
  }

  /** Compile and rewind. Returns false (and reports) when the script will not build. */
  const reset = (text: string): ScriptRunner | null => {
    runner.current?.stop()
    const binary = scriptCompile(text, (m) => setError(S.scriptCompileError + ': ' + m))
    if (!binary) return null
    setError('')
    setLines([])
    const r = scriptSetup(binary, START_VARS, {
      stack: getStack(),
      onConsole: (msg) => setLines((l) => (l.length > 400 ? l.slice(1) : l).concat(msg)),
      onStep: refresh,
      onHighlight: (i) => setHighlight(Number(i)),
      onDialog: (title, content) => setPrompt({ title, content }),
    })
    runner.current = r
    if (r) refresh(r)
    return r
  }

  /** Any change to the block list rewrites the script text. */
  const update = (next: ScriptBlockInstance[]) => {
    setList(next)
    setScriptText(blocksToScript(next))
  }

  const stop = () => {
    runner.current?.stop()
    runner.current = null
    setPrompt(null)
    setStatus(S.scriptStopped)
  }

  const addBlock = (xname: string) => {
    const b = instantiateBlock(xname)
    if (b) update(list.concat(b))
  }

  const editBlock = (index: number) => {
    setEditing(index)
    const d: Record<string, string> = {}
    for (const k in list[index].vars) d[k] = String(list[index].vars![k].value ?? '')
    setDraft(d)
  }

  const saveEdit = () => {
    const next = list.slice()
    for (const k in next[editing].vars) {
      const v = next[editing].vars![k]
      v.value = v.type == 5 ? Object.keys(draft).filter((d) => draft[d] === '1') : draft[k]
    }
    setEditing(-1)
    update(next)
  }

  const load = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      let x: MescriptFile = {}
      try {
        x = JSON.parse(String(reader.result)) as MescriptFile
      } catch {
        setError(S.scriptCompileError)
        return
      }
      setList(x.scriptBlocks ?? [])
      setScriptText(x.scriptText ?? '')
      setLines([S.scriptLoaded])
    }
    reader.readAsBinaryString(file)
  }

  const save = () => {
    const blob = new Blob([
      JSON.stringify(
        { scriptText, mescript: btoa(scriptCompile(scriptText)), blocks: SCRIPT_BLOCKS, scriptBlocks: list },
        null,
        '  ',
      ),
    ])
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'script.mescript'
    a.click()
    URL.revokeObjectURL(url)
  }

  const running = (runner.current?.state ?? 0) > 0
  const shown = Object.keys(SCRIPT_BLOCKS)
    .filter((k) => k.charCodeAt(0) !== 95)
    .filter((k) => {
      const f = filter.toLowerCase()
      const b = SCRIPT_BLOCKS[k]
      return b.name.toLowerCase().includes(f) || b.desc.toLowerCase().includes(f)
    })
  function move(from: number, delta: number) {
    const next = list.slice()
    const to = from + delta
    ;[next[from], next[to]] = [next[to], next[from]]
    update(next)
  }

  return (
    <div class="page">
      {running && (
        <div class="statusbar script-status">
          <b>{S.scriptRunningBar}</b>
          <span class="script-status-msg">{lines[lines.length - 1] ?? ''}</span>
          <button type="button" class="btn" onClick={stop}>
            {S.scriptStopScript}
          </button>
        </div>
      )}

      <div class="page-header">
        <span class="script-status-text">{status}</span>
      </div>

      {error && <div class="banner error">{error}</div>}

      <div class="btn-row">
        {FEAT_ScriptingEditor ? (
          <>
            <button type="button" class="btn" onClick={() => setBuilder(false)} disabled={!builder}>
              {S.scriptViewEditor}
            </button>
            <button type="button" class="btn" onClick={() => setBuilder(true)} disabled={builder}>
              {S.scriptViewBuilder}
            </button>
            <button type="button" class="btn" onClick={() => setConfirmNew(true)}>
              {S.scriptNew}
            </button>
          </>
        ) : null}
        <button type="button" class="btn" onClick={() => fileRef.current?.click()}>
          {S.scriptLoad}
        </button>
        {FEAT_FileSaver && (
          <button type="button" class="btn" onClick={save}>
            {S.scriptSave}
          </button>
        )}
        <button type="button" class="btn" onClick={() => reset(scriptText)}>
          {S.scriptRestart}
        </button>
        <button type="button" class="btn" onClick={() => (runner.current ?? reset(scriptText))?.start(100)}>
          {S.scriptContinue}
        </button>
        <button type="button" class="btn" onClick={() => runner.current?.stop()}>
          {S.scriptBreak}
        </button>
        <button
          type="button"
          class="btn"
          onClick={() => {
            runner.current?.stop()
            ;(runner.current ?? reset(scriptText))?.step()
          }}
        >
          {S.scriptStep}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".mescript"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = (e.target as HTMLInputElement).files?.[0]
            if (f) load(f)
          }}
        />
      </div>

      {FEAT_ScriptingEditor && builder ? (
        <div class="script-builder">
          <aside class="script-library">
            <input
              class="script-filter"
              type="text"
              placeholder={S.scriptFilterBlocks}
              value={filter}
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
            />
            <div class="script-library-list">
              {shown.map((k) => (
                <button
                  type="button"
                  key={k}
                  class="script-library-item"
                  title={SCRIPT_BLOCKS[k].desc}
                  onClick={() => addBlock(k)}
                >
                  {SCRIPT_BLOCKS[k].name}
                </button>
              ))}
            </div>
          </aside>
          <div class="script-blocks">
            {list.length === 0 ? <p class="table-empty">{S.scriptEmptyScript}</p> : null}
            {list.map((b, i) => (
              <div key={b.id} class={'script-block' + (highlight === i ? ' running' : '')}>
                <div class="script-block-head">
                  <b>{b.name}</b>
                  <span class="btn-row">
                    <button type="button" class="btn" disabled={i === 0} onClick={() => move(i, -1)}>
                      ↑
                    </button>
                    <button
                      type="button"
                      class="btn"
                      disabled={i === list.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </button>
                    <button type="button" class="btn" onClick={() => editBlock(i)}>
                      {S.scriptEdit}
                    </button>
                    <button type="button" class="btn" onClick={() => update(list.filter((_, x) => x !== i))}>
                      {S.scriptDelete}
                    </button>
                  </span>
                </div>
                {b.vars && (
                  <dl class="kv">
                    {Object.keys(b.vars).map((k) => (
                      <Fragment key={k}>
                        <dt title={b.vars![k].desc}>{b.vars![k].name}</dt>
                        <dd>{varText(b.vars![k])}</dd>
                      </Fragment>
                    ))}
                  </dl>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <textarea
          class="script-text"
          spellcheck={false}
          value={scriptText}
          onInput={(e) => setScriptText((e.target as HTMLTextAreaElement).value)}
        />
      )}

      <h2 class="table-title">{S.scriptVariables}</h2>
      <div class="script-vars">
        {Object.keys(vars).length === 0 ? <p class="table-empty">{S.scriptStoppedNoScript}</p> : null}
        {Object.keys(vars)
          .sort()
          .map((k) => (
            <div key={k} class="script-var">
              <b>{k}</b> = {typeof vars[k] === 'object' ? JSON.stringify(vars[k]) : String(vars[k])}
            </div>
          ))}
      </div>

      <h2 class="table-title">{S.scriptConsole}</h2>
      <pre class="script-console">{lines.join('\n')}</pre>

      {editing >= 0 && list[editing] && (
        <Dialog
          title={list[editing].name}
          width={620}
          buttons={[
            { label: S.scriptDelete, value: 'delete' },
            { label: S.cancel, value: 'cancel' },
            { label: S.ok, value: 'ok', primary: true },
          ]}
          onClose={(v) => {
            if (v === 'delete') update(list.filter((_, x) => x !== editing))
            else if (v === 'ok') saveEdit()
            setEditing(-1)
          }}
        >
          <p class="script-block-desc">{list[editing].desc}</p>
          {Object.keys(list[editing].vars ?? {}).map((k) => {
            const v = list[editing].vars![k]
            const type = Number(v.type)
            if (type == 5) {
              return (
                <fieldset key={k} class="script-var-set">
                  <legend>{v.name}</legend>
                  {Object.keys(v.values ?? {}).map((y) => (
                    <label key={y} class="script-var-check">
                      <input
                        type="checkbox"
                        checked={(draft[k] ?? '').split(',').includes(y)}
                        onChange={(e) =>
                          setDraft((d) => {
                            const on = new Set((d[k] ?? '').split(',').filter(Boolean))
                            ;(e.target as HTMLInputElement).checked ? on.add(y) : on.delete(y)
                            return { ...d, [k]: Array.from(on).join(',') }
                          })
                        }
                      />
                      {v.values![y]}
                    </label>
                  ))}
                </fieldset>
              )
            }
            if (type == 6) {
              return (
                <label key={k} class="script-var-field">
                  {v.name}
                  <input
                    type="file"
                    onChange={(e) => {
                      const f = (e.target as HTMLInputElement).files?.[0]
                      if (!f) return
                      const reader = new FileReader()
                      reader.onload = () => setDraft((d) => ({ ...d, [k]: btoa(String(reader.result)) }))
                      reader.readAsBinaryString(f)
                    }}
                  />
                </label>
              )
            }
            if (type == 3) {
              return (
                <label key={k} class="script-var-field">
                  {v.name}
                  <select
                    value={draft[k] ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, [k]: (e.target as HTMLSelectElement).value }))}
                  >
                    {Object.keys(v.values ?? {}).map((y) => (
                      <option key={y} value={y}>
                        {v.values![y]}
                      </option>
                    ))}
                  </select>
                </label>
              )
            }
            const onDraft = (e: Event) => setDraft((d) => ({ ...d, [k]: (e.target as HTMLInputElement).value }))
            return (
              <label key={k} class="script-var-field">
                {v.name}
                {/* Type 2 is a digits-only text box, exactly as the legacy rendered it. */}
                {type == 4 ? (
                  <input type="password" maxLength={v.maxlength} value={draft[k] ?? ''} onInput={onDraft} />
                ) : (
                  <input type="text" maxLength={v.maxlength} value={draft[k] ?? ''} onInput={onDraft} />
                )}
              </label>
            )
          })}
        </Dialog>
      )}

      {confirmNew && (
        <Dialog
          title={S.scriptNew}
          buttons={[
            { label: S.cancel, value: 'cancel' },
            { label: S.ok, value: 'ok', primary: true },
          ]}
          onClose={(v) => {
            if (v === 'ok') {
              stop()
              update([])
              setScriptText('')
              setVars({})
            }
            setConfirmNew(false)
          }}
        >
          <p>{S.scriptNewConfirm}</p>
        </Dialog>
      )}

      {prompt && (
        <Dialog title={prompt.title} buttons={[{ label: S.ok, value: 'ok', primary: true }]} onClose={() => setPrompt(null)}>
          <pre class="script-console">{prompt.content}</pre>
        </Dialog>
      )}
    </div>
  )
}

