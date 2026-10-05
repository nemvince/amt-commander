/**
 * mscript: the MeshCommander script language -- compiler, runner and decompiler.
 *
 * Ported from amt-script-0.2.0.js plus the block-builder glue from index.html:11995-12315.
 * This module is only imported when `FEAT_Scripting` is on, so none of it reaches
 * the small or medium artifacts.
 *
 * Three rules inherited from the legacy code and kept here on purpose:
 *
 * - A script is compiled to a binary string (magic `0x247D2945`, version 1) so label
 *   targets can be patched in after the whole script has been scanned.
 * - Every argument is a *name*, not a value: `{Var}` placeholders are substituted from
 *   the variable table at step time, string literals are `decodeURI`'d on the way in
 *   (which is how block code embeds `"` and `{` inside a quoted argument), and integers
 *   and labels live in throwaway `__0`, `__1`... variables.
 * - Comparisons are loose. Block code writes `set PullSystemStatus "1"` (a string) and
 *   the `_end` block then jumps on `PullSystemStatus "!=" 1` (a number), so strict
 *   equality there would silently skip every pull.
 *
 * The runner is DOM-free: the AMT stack and every UI hook arrive through `ScriptDeps`.
 */

import type { AmtStack } from './amt-stack'
import { intToStr, intToStrX, readShort, shortToStr, shortToStrX } from './bytes'
import { rstrMd5 } from './md5'
import { getSidString, sidToBytes } from './sid'
import {
  PullAccounts,
  PullAgentPresence,
  PullAuditLog,
  PullEventLog,
  PullHardware,
  PullRemoteAccess,
  PullSubscriptions,
  PullSystemDefense,
  PullSystemStatus,
} from '../state/device'
import blockFile from './script-blocks.json'

/* ------------------------------------------------------------------ blocks */

export interface ScriptVar {
  name: string
  desc: string
  /** 1 = text, 2 = number, 3 = drop-down, 4 = password, 5 = multi-select, 6 = file. */
  type: number | string
  value: string | string[] | null
  maxlength?: number
  values?: Record<string, string>
}

export interface ScriptBlock {
  name: string
  desc: string
  code: string
  vars?: Record<string, ScriptVar>
}

/** A block placed in the script, tagged with the library entry it came from. */
export type ScriptBlockInstance = ScriptBlock & { id: number; xname: string }

/** The building-block library, verbatim from scriptblocks.txt. */
export const SCRIPT_BLOCKS = blockFile.blocks as unknown as Record<string, ScriptBlock>

/**
 * Clone a library block into a script instance. `%%%name%%%` in the code is replaced
 * with the variable values and `%%%~%%%` with the block's own index when the script
 * text is generated, so the index has to be known before it runs.
 */
export function instantiateBlock(xname: string): ScriptBlockInstance | null {
  const b = SCRIPT_BLOCKS[xname]
  if (!b) return null
  return { ...JSON.parse(JSON.stringify(b)), id: Math.random(), xname } as ScriptBlockInstance
}

/**
 * Turn the block list into runnable script text (script_blocksToScript, index.html:12302).
 * The hidden `_start` / `_end` library blocks wrap the user's blocks.
 */
export function blocksToScript(list: ScriptBlockInstance[]): string {
  let script = ''
  if (SCRIPT_BLOCKS['_start']) {
    script += '##### Starting Block #####\r\n' + SCRIPT_BLOCKS['_start'].code + '\r\n\r\n'
  }
  list.forEach((b, i) => {
    let code = b.code.split('%%%~%%%').join(String(i))
    for (const j in b.vars) code = code.split('%%%' + j + '%%%').join(String(b.vars![j].value ?? ''))
    script += '##### Block: ' + b.name + ' #####\r\nHighlightBlock __t ' + i + '\r\n' + code + '\r\n\r\n'
  })
  if (SCRIPT_BLOCKS['_end']) {
    script += '##### Ending Block #####\r\n' + SCRIPT_BLOCKS['_end'].code + '\r\nHighlightBlock\r\n'
  }
  return script
}

/* ------------------------------------------------------------ binary helpers */

function readInt(v: string, p: number): number {
  // * 0x1000000 rather than << 24: the shift would force this into a signed int32.
  return v.charCodeAt(p) * 0x1000000 + (v.charCodeAt(p + 1) << 16) + (v.charCodeAt(p + 2) << 8) + v.charCodeAt(p + 3)
}
function readSInt(v: string, p: number): number {
  return (v.charCodeAt(p) << 24) + (v.charCodeAt(p + 1) << 16) + (v.charCodeAt(p + 2) << 8) + v.charCodeAt(p + 3)
}
function readShortX(v: string, p: number): number {
  return (v.charCodeAt(p + 1) << 8) + v.charCodeAt(p)
}
function readIntX(v: string, p: number): number {
  return v.charCodeAt(p + 3) * 0x1000000 + (v.charCodeAt(p + 2) << 16) + (v.charCodeAt(p + 1) << 8) + v.charCodeAt(p)
}
/** Hex text to the raw string the interpreter actually runs on. */
function hex2rstr(d: string): string {
  const m = d.match(/../g)
  if (!m) return ''
  let r = ''
  let t: string | undefined
  while ((t = m.shift())) r += String.fromCharCode(parseInt(t, 16))
  return r
}
function rstr2hex(input: string): string {
  let r = ''
  for (let i = 0; i < input.length; i++) r += (input.charCodeAt(i) + 0x100).toString(16).slice(-2).toUpperCase()
  return r
}

/* ------------------------------------------------------------- function tables */

type Fn2 = (a: unknown, b: unknown, c: unknown, d: unknown, e: unknown, f: unknown) => unknown
/** ARG2..ARG7, as handed to a value function. */
type FnArgs = [unknown, unknown, unknown, unknown, unknown, unknown]
type Fn3 = (runner: ScriptRunner, ...args: FnArgs) => unknown

/** Core commands, cmdid 0..9999. */
const FN1 = [
  'nop', 'jump', 'set', 'print', 'dialog', 'getitem', 'substr', 'indexof', 'split', 'join', 'length',
  'jsonparse', 'jsonstr', 'add', 'substract', 'parseint', 'wsbatchenum', 'wsput', 'wscreate', 'wsdelete',
  'wsexec', 'scriptspeed', 'wssubscribe', 'wsunsubscribe', 'readchar', 'signwithdummyca',
]

/** Value functions, cmdid 10000..19999: ARG1 = func(ARG2, ARG3, ... ARG7). */
const FN2_NAMES = [
  'encodeuri', 'decodeuri', 'passwordcheck', 'atob', 'btoa', 'hex2str', 'str2hex', 'random', 'md5',
  'maketoarray', 'readshort', 'readshortx', 'readint', 'readsint', 'readintx', 'shorttostr',
  'shorttostrx', 'inttostr', 'inttostrx',
]

const FN2X: Fn2[] = [
  (a) => encodeURI(String(a ?? '')),
  (a) => decodeURI(String(a ?? '')),
  (a) => passwordCheck(String(a ?? '')),
  (a) => atob(String(a ?? '')),
  (a) => btoa(String(a ?? '')),
  (a) => hex2rstr(String(a ?? '')),
  (a) => rstr2hex(String(a ?? '')),
  (a) => Math.floor(Math.random() * Number(a ?? 0)),
  (a) => rstrMd5(a == null ? null : String(a)),
  (a) => (typeof a === 'object' ? a : [a]),
  (a, b) => readShort(String(a ?? ''), Number(b ?? 0)),
  (a, b) => readShortX(String(a ?? ''), Number(b ?? 0)),
  (a, b) => readInt(String(a ?? ''), Number(b ?? 0)),
  (a, b) => readSInt(String(a ?? ''), Number(b ?? 0)),
  (a, b) => readIntX(String(a ?? ''), Number(b ?? 0)),
  (a) => shortToStr(Number(a ?? 0)),
  (a) => shortToStrX(Number(a ?? 0)),
  (a) => intToStr(Number(a ?? 0)),
  (a) => intToStrX(Number(a ?? 0)),
]

/**
 * Host functions, cmdid 20000+: ARG1 = func(runner, ARG2, ... ARG7).
 *
 * No FEAT gating here: scripting only ships in the large tier, where every flag these
 * hang off (EventLog, AuditLog, HardwareInfo, SystemDefense, AgentPresence,
 * EventSubscriptions, Scripting-Editor) is already on. Holes are commands the firmware
 * edition does not provide -- the certificate manager and the computer selector. Their
 * names still compile so old scripts load; the call just does nothing, exactly as in
 * the legacy firmware build.
 */
const FN3_NAMES = [
  'pullsystemstatus', 'pulleventlog', 'pullauditlog', 'pullcertificates', 'pullwatchdog',
  'pullsystemdefense', 'pullhardware', 'pulluserinfo', 'pullremoteaccess', 'highlightblock',
  'disconnect', 'getsidstring', 'getsidbytearray', 'pulleventsubscriptions',
]

function hostFunctions(deps: ScriptDeps): (Fn3 | undefined)[] {
  return [
    () => PullSystemStatus(),
    () => PullEventLog(),
    () => PullAuditLog(),
    undefined, // pullcertificates
    () => PullAgentPresence(),
    () => PullSystemDefense(),
    () => PullHardware(),
    () => PullAccounts(),
    () => PullRemoteAccess(),
    (_r, a) => deps.onHighlight?.(a),
    undefined, // disconnect
    (_r, a) => getSidString(String(a ?? '')),
    (_r, a) => sidToBytes(String(a ?? '')),
    () => PullSubscriptions(),
  ]
}

/** At least 8 characters with an upper, a lower, a digit and a symbol. */
function passwordCheck(p: string): boolean {
  if (p.length < 8) return false
  let upper = 0
  let lower = 0
  let number = 0
  let nonalpha = 0
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i)
    if (c > 64 && c < 91) upper = 1
    else if (c > 96 && c < 123) lower = 1
    else if (c > 47 && c < 58) number = 1
    else nonalpha = 1
  }
  return upper + lower + number + nonalpha === 4
}

const HTTP_ERRORS: Record<number, string> = {
  200: 'OK',
  401: 'Authentication Error',
  408: 'Timeout Error',
  601: 'WSMAN Parsing Error',
  602: 'Unable to parse HTTP response header',
  603: 'Unexpected HTTP enum response',
  604: 'Unexpected HTTP pull response',
  997: 'Invalid Digest Realm',
}

/* ------------------------------------------------------------------- runner */

export interface ScriptDeps {
  /** Device stack; the ws* commands go through it. */
  stack?: AmtStack | null
  /** `print` output. Defaults to console.log. */
  onConsole?: (msg: string) => void
  /** Fired after every step so the UI can refresh state and variables. */
  onStep?: (runner: ScriptRunner) => void
  /** `HighlightBlock <dest> <index>` -- which library block is running. */
  onHighlight?: (index: unknown) => void
  /** `dialog(title, content, buttons)` -- the host renders it and calls dialogOk(). */
  onDialog?: (title: string, content: string, buttons: unknown) => void
}

export interface ScriptRunner {
  /** 0 = stopped, 1 = running, 2 = waiting on a device call or a dialog, 9 = error. */
  state: number
  ip: number
  stepspeed: number
  script: string
  dialog: boolean
  variables: Record<string, unknown>
  timer: number | null
  start(stepspeed: number): void
  stop(): void
  reset(): void
  step(): ScriptRunner
  /** Resolve a pending `dialog` command. */
  dialogOk(button: string): void
  wsmanReturn(name: string, responses: unknown, status: number): void
  getVar(name: string | undefined): unknown
  setVar(name: string, val: unknown): void
  toString(x: unknown): string
}

export function scriptSetup(
  binary: string,
  startvars: Record<string, unknown>,
  deps: ScriptDeps = {},
): ScriptRunner | null {
  // A script must have at least the 6 byte header, and it must be ours.
  if (binary.length < 6 || readInt(binary, 0) !== 0x247d2945 || readShort(binary, 4) > 1) {
    console.error('Invalid binary script')
    return null
  }
  const fn3 = hostFunctions(deps)
  const obj = {
    ip: 0,
    state: 1,
    stepspeed: 0,
    timer: null as number | null,
    dialog: false,
    script: binary.substring(6),
    variables: { ...startvars },
  } as unknown as ScriptRunner

  function getVarEx(parts: string[], val: unknown): unknown {
    try {
      if (parts.length === 0) return val
      return getVarEx(parts.slice(1), (val as Record<string, unknown>)[parts[0]])
    } catch {
      return null
    }
  }
  function setVarEx(parts: string[], vars: Record<string, unknown>, val: unknown): void {
    if (parts.length === 1) vars[parts[0]] = val
    else setVarEx(parts.slice(1), vars[parts[0]] as Record<string, unknown>, val)
  }
  obj.getVar = (name) => (name === undefined ? undefined : getVarEx(name.split('.'), obj.variables))
  obj.setVar = (name, val) => setVarEx(name.split('.'), obj.variables, val)
  obj.toString = (x) => (typeof x === 'object' && x !== null ? JSON.stringify(x) : x === undefined ? '' : String(x))

  obj.stop = () => {
    if (obj.timer !== null) clearInterval(obj.timer)
    obj.timer = null
    obj.stepspeed = 0
  }
  obj.reset = () => {
    obj.stop()
    obj.ip = 0
    obj.variables = { ...startvars }
    obj.dialog = false
    obj.state = 1
  }
  obj.start = (stepspeed: number) => {
    obj.stop()
    obj.stepspeed = stepspeed
    if (stepspeed > 0) obj.timer = setInterval(() => obj.step(), stepspeed)
  }
  obj.dialogOk = (button: string) => {
    obj.variables['DialogSelect'] = button
    obj.state = 1
    obj.dialog = false
    deps.onStep?.(obj)
  }
  obj.wsmanReturn = (name: string, responses: unknown, status: number) => {
    obj.setVar(name, responses)
    obj.setVar('wsman_result', status)
    obj.setVar('wsman_result_str', HTTP_ERRORS[status] ?? 'Error #' + status)
    obj.state = 1
    deps.onStep?.(obj)
  }

  /** One sink for every stack callback; the stack hands the tag straight back. */
  const sink = (_stack: unknown, name: string, responses: unknown, status: number) =>
    obj.wsmanReturn(name, responses, status)

  /** Hand a device call to the stack, parking the script until it answers. */
  function device(fn: (stack: AmtStack) => void): void {
    if (!deps.stack) {
      obj.setVar('_exception', 'Not connected to a device')
      return
    }
    obj.state = 2
    fn(deps.stack)
  }

  obj.step = () => {
    if (obj.state !== 1) return obj
    if (obj.ip < obj.script.length) {
      try {
        const cmdid = readShort(obj.script, obj.ip)
        const cmdlen = readShort(obj.script, obj.ip + 2)
        const argcount = readShort(obj.script, obj.ip + 4)
        let argptr = obj.ip + 6
        const args: string[] = []

        // Throwaway argument variables are cleared on every step.
        for (const i in obj.variables) if (i.startsWith('__')) delete obj.variables[i]

        for (let i = 0; i < argcount; i++) {
          const arglen = readShort(obj.script, argptr)
          let argval = obj.script.substring(argptr + 2, argptr + 2 + arglen)
          const argtyp = argval.charCodeAt(0)
          argval = argval.substring(1)
          if (argtyp < 2) {
            argval = argval.replace(/\{([^{}]*)\}/g, (_m, name) => String(obj.getVar(name) ?? ''))
            if (argtyp === 1) {
              obj.variables['__' + i] = decodeURI(argval)
              argval = '__' + i
            }
            args.push(argval)
          } else {
            obj.variables['__' + i] = readSInt(argval, 0)
            args.push('__' + i)
          }
          argptr += 2 + arglen
        }

        obj.ip += cmdlen

        const argsval: unknown[] = []
        for (let i = 0; i < 10; i++) argsval.push(obj.getVar(args[i]))
        let storeInArg0: unknown

        if (cmdid < 10000) {
          switch (cmdid) {
            case 0: // nop
              break
            case 1: { // jump(label) | jump(label, a, compare, b)
              const [dest, a, op, b] = argsval as [number, number, string, number]
              const taken =
                (op === '<' && a < b) ||
                (op === '<=' && a <= b) ||
                (op === '!=' && a != b) ||
                (op === '=' && a == b) ||
                (op === '>=' && a >= b) ||
                (op === '>' && a > b)
              if (!op || taken) obj.ip = dest
              break
            }
            case 2: // set(variable, value) -- a bare `set var` deletes it
              if (args[1] === undefined) delete obj.variables[args[0]]
              else obj.setVar(args[0], argsval[1])
              break
            case 3: // print(message)
              ;(deps.onConsole ?? ((m: string) => console.log(m)))(obj.toString(argsval[0]))
              break
            case 4: // dialog(title, content, buttons)
              obj.state = 2
              obj.dialog = true
              deps.onDialog?.(obj.toString(argsval[0]), obj.toString(argsval[1]), argsval[2])
              break
            case 5: { // getitem(dest, list, property, value)
              const list = argsval[1] as Record<string, unknown>
              for (const i in list) if ((list[i] as Record<string, unknown>)[argsval[2] as string] == argsval[3]) storeInArg0 = i
              break
            }
            case 6: // substr(dest, src, index, len)
              storeInArg0 = (argsval[1] as string).substr(argsval[2] as number, argsval[3] as number)
              break
            case 7: // indexof(dest, src, what)
              storeInArg0 = (argsval[1] as string).indexOf(argsval[2] as string)
              break
            case 8: // split(dest, src, separator)
              storeInArg0 = (argsval[1] as string).split(argsval[2] as string)
              break
            case 9: // join(dest, list, separator)
              storeInArg0 = (argsval[1] as string[]).join(argsval[2] as string)
              break
            case 10: // length(dest, src)
              storeInArg0 = (argsval[1] as string).length
              break
            case 11: // jsonparse(dest, json)
              storeInArg0 = JSON.parse(argsval[1] as string)
              break
            case 12: // jsonstr(dest, src)
              storeInArg0 = JSON.stringify(argsval[1])
              break
            case 13: // add(dest, a, b)
              storeInArg0 = (argsval[1] as number) + (argsval[2] as number)
              break
            case 14: // substract(dest, a, b)
              storeInArg0 = (argsval[1] as number) - (argsval[2] as number)
              break
            case 15: // parseint(dest, src)
              storeInArg0 = parseInt(argsval[1] as string)
              break
            case 16: // wsbatchenum(name, objectList)
              device((s) => s.BatchEnum(argsval[0] as string, argsval[1] as string[], sink, obj))
              break
            case 17: // wsput(name, args)
              device((s) => s.Put(argsval[0] as string, argsval[1] as never, sink, obj))
              break
            case 18: // wscreate(name, args)
              device((s) => s.Create(argsval[0] as string, argsval[1] as never, sink, obj))
              break
            case 19: // wsdelete(name, selectors)
              device((s) => s.Delete(argsval[0] as string, argsval[1] as never, sink, obj))
              break
            case 20: // wsexec(name, method, args, selectors)
              device((s) =>
                s.Exec(argsval[0] as string, argsval[1] as string, argsval[2] as never, sink, obj, 0, argsval[3] as never),
              )
              break
            case 21: // scriptspeed(ms)
              obj.stepspeed = argsval[0] as number
              if (obj.timer !== null) {
                clearInterval(obj.timer)
                obj.timer = obj.stepspeed > 0 ? setInterval(() => obj.step(), obj.stepspeed) : null
              }
              break
            case 22: // wssubscribe(name, delivery, url, selectors, opaque, user, pass)
              device((s) =>
                s.Subscribe(
                  argsval[0] as string,
                  argsval[1] as string,
                  argsval[2] as string,
                  sink,
                  obj,
                  0,
                  argsval[3] as never,
                  argsval[4] as string,
                ),
              )
              break
            case 23: // wsunsubscribe(name, selectors)
              device((s) => s.UnSubscribe(argsval[0] as string, sink, obj, 0, argsval[1] as never))
              break
            case 24: // readchar(dest, str, pos)
              storeInArg0 = (argsval[1] as string).charCodeAt(argsval[2] as number)
              break
            default:
              obj.state = 9
              console.error('Script Error, unknown command: ' + cmdid)
          }
        } else if (cmdid < 20000) {
          storeInArg0 = FN2X[cmdid - 10000]?.(...(argsval.slice(1, 7) as FnArgs))
        } else {
          // Host functions take the runner as their first argument.
          storeInArg0 = fn3[cmdid - 20000]?.(obj, ...((argsval.slice(1, 7) as FnArgs)))
        }

        if (storeInArg0 !== undefined && storeInArg0 !== null) obj.setVar(args[0], storeInArg0)
      } catch (e) {
        obj.setVar('_exception', e instanceof Error ? e.message : String(e))
      }
    }

    if (obj.state === 1 && obj.ip >= obj.script.length) {
      obj.state = 0
      obj.stop()
    }
    deps.onStep?.(obj)
    return obj
  }

  obj.reset()
  return obj
}

/* ----------------------------------------------------------------- compiler */

/**
 * Compile mscript text into the binary form the runner executes. Returns '' and calls
 * `onmsg` on the first unknown command or dangling label.
 */
export function scriptCompile(script: string, onmsg?: (m: string) => void): string {
  let r = ''
  const labels: Record<string, number> = {}
  const labelswap: [string, number][] = []
  const swaps: Record<string, string> = {}

  for (const raw of script.split('\n')) {
    // ##SWAP <find> <replace> -- how block code embeds a variable value.
    if (raw.startsWith('##SWAP ')) {
      const x = raw.split(' ')
      if (x.length === 3) swaps[x[1]] = x[2]
    }
    if (raw[0] === '#' || raw.length === 0) continue
    const line = Object.keys(swaps).reduce((l, k) => l.split(k).join(swaps[k]), raw)
    const keywords = line.match(/"[^"]*"|[^\s"]+/g)
    if (!keywords || keywords.length === 0) continue
    if (line[0] === ':') {
      labels[keywords[0].toUpperCase()] = r.length
      continue
    }

    let funcIndex = FN1.indexOf(keywords[0].toLowerCase())
    if (funcIndex === -1) {
      funcIndex = FN2_NAMES.indexOf(keywords[0].toLowerCase())
      if (funcIndex >= 0) funcIndex += 10000
    }
    if (funcIndex === -1) {
      funcIndex = FN3_NAMES.indexOf(keywords[0].toLowerCase())
      if (funcIndex >= 0) funcIndex += 20000
    }
    if (funcIndex === -1) {
      onmsg?.('Unable to compile, unknown command: ' + keywords[0])
      return ''
    }

    // CommandId, CmdSize, ArgCount, then Arg1Len/Arg1, Arg2Len/Arg2...
    let cmd = shortToStr(keywords.length - 1)
    for (let j = 0; j < keywords.length; j++) {
      if (j === 0) continue
      const kw = keywords[j]
      if (kw[0] === ':') {
        labelswap.push([kw, r.length + cmd.length + 7])
        cmd += shortToStr(5) + String.fromCharCode(3) + intToStr(0xffffffff)
      } else {
        const argint = parseInt(kw)
        if (argint == Number(kw)) cmd += shortToStr(5) + String.fromCharCode(2) + intToStr(argint)
        else if (kw[0] === '"' && kw[kw.length - 1] === '"') cmd += shortToStr(kw.length - 1) + String.fromCharCode(1) + kw.slice(1, -1)
        else cmd += shortToStr(kw.length + 1) + String.fromCharCode(0) + kw
      }
    }
    cmd = shortToStr(funcIndex) + shortToStr(cmd.length + 4) + cmd
    r += cmd
  }

  // Patch the placeholder labels now that every label position is known.
  for (const [label, position] of labelswap) {
    const target = labels[label.toUpperCase()]
    if (target === undefined) {
      onmsg?.('Unable to compile, unknown label: ' + label)
      return ''
    }
    r = r.substr(0, position) + intToStr(target) + r.substr(position + 4)
  }
  return intToStr(0x247d2945) + shortToStr(1) + r
}

/**
 * Turn a compiled script back into text, for the editor's "currently executing"
 * status. `script` is the *body* -- what `ScriptRunner.script` holds, i.e. the
 * compiled bytes without the 6 byte header. Pass a position to decompile just
 * that one command; omit it for the whole script.
 */
export function scriptDecompile(script: string, onecmd = -1): string {
  let r = ''
  let ptr = onecmd >= 0 ? onecmd : 0
  // Keyed by both the numeric target and its ':label<n>' text, as the legacy did.
  const labels: Record<string, unknown> = {}

  while (ptr < script.length) {
    const cmdid = readShort(script, ptr)
    const cmdlen = readShort(script, ptr + 2)
    const argcount = readShort(script, ptr + 4)
    let argptr = ptr + 6
    let argstr = ''
    if (onecmd < 0) r += ':label' + ptr + '\n'

    for (let i = 0; i < argcount; i++) {
      const arglen = readShort(script, argptr)
      const argval = script.substring(argptr + 2, argptr + 2 + arglen)
      const argtyp = argval.charCodeAt(0)
      if (argtyp === 0) argstr += ' ' + argval.substring(1)
      else if (argtyp === 1) argstr += ' "' + argval.substring(1) + '"'
      else if (argtyp === 2) argstr += ' ' + readInt(argval, 1)
      else if (argtyp === 3) {
        const target = readInt(argval, 1)
        let label = labels[target] as string | undefined
        if (!label) {
          label = ':label' + target
          labels[label] = target
        }
        argstr += ' ' + label
      }
      argptr += 2 + arglen
    }

    const name = cmdid < 10000 ? FN1[cmdid] : cmdid >= 20000 ? FN3_NAMES[cmdid - 20000] : FN2_NAMES[cmdid - 10000]
    r += name + argstr + '\n'
    ptr += cmdlen
    if (onecmd >= 0) return r
  }

  // Drop the synthetic labels that no jump actually targets.
  return r
    .split('\n')
    .filter((line) => line[0] !== ':' || labels[line] !== undefined)
    .join('\n')
}
