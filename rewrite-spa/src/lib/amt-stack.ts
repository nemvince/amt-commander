/**
 * Intel AMT stack: enumeration pipelining, batch operations and status decoding
 * on top of the WSMAN SOAP layer.
 *
 * Ported from AmtStackCreateService() in amt-0.2.0.js. NodeWebkit-only paths
 * (TLS certificate pinning, client-side digest, forge) are deliberately absent:
 * the firmware edition lets the browser handle the 401 challenge.
 */

import { createWsmanStack, type SelectorSet, type Wsman, type WsmanNode, type WsmanResponse } from './wsman'

const PFX_AMT = 'http://intel.com/wbem/wscim/1/amt-schema/1/'
const PFX_CIM = 'http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/'
const PFX_IPS = 'http://intel.com/wbem/wscim/1/ips-schema/1/'

export type AmtResult = {
  response: WsmanNode | null
  responses: WsmanResponse | null
  status: number
}

/** Sink for single-resource operations (Get/Put/Create/Delete/Exec): one response. */
export type AmtObjectSink = (
  stack: AmtStack,
  name: string,
  response: WsmanResponse | null,
  status: number,
  tag: unknown,
) => void

/** Sink for Enum: the flattened instance list pulled from the device. */
export type AmtEnumSink = (
  stack: AmtStack,
  name: string,
  items: WsmanNode[] | null,
  status: number,
  tag: unknown,
) => void

export type BatchCallback = (
  stack: AmtStack,
  batchname: string,
  results: Record<string, AmtResult>,
  status: number,
  tag: unknown,
) => void

export interface AmtStack {
  wsman: Wsman
  onProcessChanged: ((pending: number, max: number) => void) | null
  GetPendingActions(): number
  Subscribe(
    name: string,
    delivery: string,
    url: string,
    callback: AmtObjectSink,
    tag: unknown,
    pri: number,
    selectors?: SelectorSet,
    opaque?: string,
  ): void
  UnSubscribe(name: string, callback: AmtObjectSink, tag: unknown, pri: number, selectors?: SelectorSet): void
  Get(name: string, callback: AmtObjectSink, tag?: unknown, pri?: number): void
  Put(name: string, putobj: WsmanNode, callback: AmtObjectSink, tag?: unknown, pri?: number, selectors?: SelectorSet): void
  Create(name: string, putobj: WsmanNode, callback: AmtObjectSink, tag?: unknown, pri?: number): void
  Delete(name: string, selectors: WsmanNode, callback: AmtObjectSink, tag?: unknown, pri?: number): void
  Exec(
    name: string,
    method: string,
    args: WsmanNode,
    callback: AmtObjectSink,
    tag?: unknown,
    pri?: number,
    selectors?: SelectorSet,
  ): void
  ExecWithXml(
    name: string,
    method: string,
    args: WsmanNode,
    callback: AmtObjectSink,
    tag?: unknown,
    pri?: number,
    selectors?: SelectorSet,
  ): void
  Enum(name: string, callback: AmtEnumSink, tag?: unknown, pri?: number): void
  BatchEnum(
    batchname: string | null,
    names: string[],
    callback: BatchCallback,
    tag?: unknown,
    continueOnError?: boolean,
    pri?: number,
  ): void
  BatchGet(batchname: string, names: string[], callback: BatchCallback, tag?: unknown, pri?: number): void
  CompleteName(name: string): string
  CompleteExecResponse(resp: WsmanResponse | null): WsmanResponse | null
  RequestPowerStateChange(PowerState: number, cb: AmtObjectSink): void
  RequestOSPowerStateChange(PowerState: number, cb: AmtObjectSink): void
  SetBootConfigRole(Role: string, cb: AmtObjectSink): void
  CancelAllQueries(s: number): void
  AmtStatusToStr(code: number): string
  AmtStatusCodes: Record<number, string>
}

export function createAmtStack(url: string): AmtStack {
  const wsman = createWsmanStack(url)
  const obj = {} as AmtStack

  obj.wsman = wsman
  obj.onProcessChanged = null
  const PendingEnums: [string, AmtEnumSink, unknown, number][] = []
  let PendingBatchOperations = 0
  let ActiveEnumsCount = 0
  const MaxActiveEnumsCount = 1
  let MaxProcess = 0
  let LastProcess = 0

  obj.GetPendingActions = function () {
    return (
      PendingEnums.length * 2 +
      ActiveEnumsCount +
      wsman.comm.PendingAjax.length +
      wsman.comm.ActiveAjaxCount +
      PendingBatchOperations
    )
  }

  function up() {
    const x = obj.GetPendingActions()
    if (MaxProcess < x) MaxProcess = x
    if (obj.onProcessChanged != null && LastProcess != x) {
      LastProcess = x
      obj.onProcessChanged(x, MaxProcess)
    }
    if (x === 0) MaxProcess = 0
  }

  function name(n: string) {
    return obj.CompleteName(n)
  }

  obj.Subscribe = function (n: string, delivery: string, url: string, callback: AmtObjectSink, tag: unknown, pri = 0, selectors?: SelectorSet, opaque?: string) {
    wsman.ExecSubscribe(name(n), delivery, url, (_ws, _resuri, response, xstatus) => {
      up()
      ;(callback)(obj, n, response, xstatus, tag)
    }, 0, pri ?? 0, selectors, opaque)
    up()
  }

  obj.UnSubscribe = function (n: string, callback: AmtObjectSink, tag: unknown, pri = 0, selectors?: SelectorSet) {
    wsman.ExecUnSubscribe(name(n), (_ws, _resuri, response, xstatus) => {
      up()
      ;(callback)(obj, n, response, xstatus, tag)
    }, 0, pri ?? 0, selectors)
    up()
  }

  obj.Get = function (n: string, callback: AmtObjectSink, tag?: unknown, pri = 0) {
    wsman.ExecGet(name(n), (_ws, _resuri, response, xstatus) => {
      up()
      ;(callback)(obj, n, response, xstatus, tag)
    }, 0, pri ?? 0)
    up()
  }

  obj.Put = function (n: string, putobj: WsmanNode, callback: AmtObjectSink, tag?: unknown, pri = 0, selectors?: SelectorSet) {
    wsman.ExecPut(name(n), putobj, (_ws, _resuri, response, xstatus) => {
      up()
      ;(callback)(obj, n, response, xstatus, tag)
    }, 0, pri ?? 0, selectors)
    up()
  }

  obj.Create = function (n: string, putobj: WsmanNode, callback: AmtObjectSink, tag?: unknown, pri = 0) {
    wsman.ExecCreate(name(n), putobj, (_ws, _resuri, response, xstatus) => {
      up()
      ;(callback)(obj, n, response, xstatus, tag)
    }, 0, pri ?? 0)
    up()
  }

  obj.Delete = function (n: string, selectors: WsmanNode, callback: AmtObjectSink, tag?: unknown, pri = 0) {
    wsman.ExecDelete(name(n), selectors as SelectorSet, (_ws, _resuri, response, xstatus) => {
      up()
      ;(callback)(obj, n, response, xstatus, tag)
    }, 0, pri ?? 0)
    up()
  }

  obj.Exec = function (n: string, method: string, args: WsmanNode, callback: AmtObjectSink, tag?: unknown, pri = 0, selectors?: SelectorSet) {
    wsman.ExecMethod(name(n), method, args, (_ws, _resuri, response, xstatus) => {
      up()
      ;(callback)(obj, n, obj.CompleteExecResponse(response), xstatus, tag)
    }, 0, pri ?? 0, selectors)
    up()
  }

  obj.ExecWithXml = function (n: string, method: string, args: WsmanNode, callback: AmtObjectSink, tag?: unknown, pri = 0, selectors?: SelectorSet) {
    wsman.ExecMethodXml(name(n), method, execArgumentsToXml(args), (_ws, _resuri, response, xstatus) => {
      up()
      ;(callback)(obj, n, obj.CompleteExecResponse(response), xstatus, tag)
    }, 0, pri ?? 0, selectors)
    up()
  }

  obj.Enum = function (n: string, callback: AmtEnumSink, tag?: unknown, pri = 0) {
    if (ActiveEnumsCount < MaxActiveEnumsCount) {
      ActiveEnumsCount++
      wsman.ExecEnum(name(n), (_ws, resuri, response, xstatus, tag0) => {
        up()
        enumStartSink(n, response, callback, resuri, xstatus, tag0)
      }, tag, pri)
    } else {
      PendingEnums.push([n, callback, tag, pri])
    }
    up()
  }

  function enumStartSink(
    n: string,
    response: WsmanResponse | null,
    callback: AmtEnumSink,
    resuri: string | undefined,
    status: number,
    tag: unknown,
  ) {
    if (status !== 200) {
      callback(obj, n, null, status, tag)
      enumDoNext(1)
      return
    }
    if (response == null || response.Header['Method'] != 'EnumerateResponse' || !response.Body?.['EnumerationContext']) {
      callback(obj, n, null, 603, tag)
      enumDoNext(1)
      return
    }
    const enumctx = response.Body['EnumerationContext'] as string
    wsman.ExecPull(resuri as string, enumctx, (_ws, r2, resp2, xstatus) => {
      enumContinueSink(n, resp2, callback, r2, [], xstatus, tag)
    }, tag, 0)
  }

  function enumContinueSink(
    n: string,
    response: WsmanResponse | null,
    callback: AmtEnumSink,
    resuri: string | undefined,
    items: WsmanNode[],
    status: number,
    tag: unknown,
  ) {
    if (status !== 200) {
      callback(obj, n, null, status, tag)
      enumDoNext(1)
      return
    }
    if (response == null || response.Header['Method'] != 'PullResponse') {
      callback(obj, n, null, 604, tag)
      enumDoNext(1)
      return
    }
    const pulled = response.Body?.['Items'] as WsmanNode | WsmanNode[] | undefined
    // A class with one instance answers with Items as an object keyed by class
    // name rather than an array; legacy walked it with for-in (amt-0.2.0.js:92-97),
    // so take the values in both shapes.
    const entries = pulled == null ? [] : Array.isArray(pulled) ? pulled : Object.values(pulled)
    for (const entry of entries) {
      if (Array.isArray(entry)) items.push(...(entry as WsmanNode[]))
      else if (entry != null && typeof entry === 'object') items.push(entry as WsmanNode)
    }
    if (response.Body?.['EnumerationContext']) {
      const enumctx = response.Body['EnumerationContext'] as string
      wsman.ExecPull(resuri as string, enumctx, (_ws, r2, resp2, xstatus) => {
        enumContinueSink(n, resp2, callback, r2, items, xstatus, tag)
      }, tag, 1)
    } else {
      enumDoNext(1)
      callback(obj, n, items, status, tag)
      up()
    }
  }

  function enumDoNext(dec: number) {
    ActiveEnumsCount -= dec
    if (ActiveEnumsCount >= MaxActiveEnumsCount || PendingEnums.length === 0) {
      up()
      return
    }
    const x = PendingEnums.shift() as [string, AmtEnumSink, unknown, number]
    obj.Enum(x[0], x[1], x[2], x[3])
    enumDoNext(0)
  }

  /**
   * Fire every name in parallel and report once all have landed. A leading `*`
   * means GET instead of ENUM, which halves the round trips for singletons.
   */
  obj.BatchEnum = function (batchname: string | null, names: string[], callback: BatchCallback, tag?: unknown, _continueOnError?: boolean, pri = 0) {
    const list = names as string[]
    type BatchResults = { [k: string]: AmtResult | number | undefined; _pending?: number }
    const results: BatchResults = { _pending: list.length }
    PendingBatchOperations += list.length
    for (const original of list) {
      let n = original
      const isGet = n[0] === '*'
      if (isGet) n = n.substring(1)
      const sink = isGet ? obj.Get : obj.Enum
      const one = sink as (n: string, cb: (stack: AmtStack, name: string, responses: unknown, status: number) => void, tag: unknown, pri: number) => void
      one(n, (_stack, name, responses, status) => {
        PendingBatchOperations--
        up()
        const r = responses as WsmanResponse | null
        results[name] = { response: r?.Body ?? null, responses: r, status } as AmtResult
        const left = results._pending ?? 0
        if (left <= 1) {
          delete results._pending
          ;(callback).call(obj, obj, batchname ?? '', results as Record<string, AmtResult>, status, tag)
        } else {
          results._pending = left - 1
        }
      }, undefined, pri)
    }
  }

  obj.BatchGet = function (batchname: string, names: string[], callback: BatchCallback, tag?: unknown, pri = 0) {
    const list = names
    const responses: Record<string, WsmanResponse> = {}
    let current = 0
    const fetchNext = () => {
      if (current >= list.length) {
        ;(callback)(obj, batchname, responses as unknown as Record<string, AmtResult>, 200, tag)
        return
      }
      wsman.ExecGet(obj.CompleteName(list[current]), (_ws, _resuri, response, xstatus) => {
        if (response == null || xstatus !== 200) {
          ;(callback)(obj, batchname, null as unknown as Record<string, AmtResult>, xstatus, tag)
        } else {
          responses[String(response.Header['Method'])] = response
          current++
          fetchNext()
        }
      }, tag, pri)
    }
    fetchNext()
    up()
  }

  obj.CompleteName = function (n) {
    if (n.indexOf('AMT_') === 0) return PFX_AMT + n
    if (n.indexOf('CIM_') === 0) return PFX_CIM + n
    if (n.indexOf('IPS_') === 0) return PFX_IPS + n
    return n
  }

  obj.CompleteExecResponse = function (resp) {
    if (resp?.Body && resp.Body['ReturnValue'] !== undefined) {
      resp.Body.ReturnValueStr = obj.AmtStatusToStr(resp.Body['ReturnValue'] as number)
    }
    return resp
  }

  const COMPUTER_SYSTEM_REF =
    '<Address xmlns="http://schemas.xmlsoap.org/ws/2004/08/addressing">http://schemas.xmlsoap.org/ws/2004/08/addressing</Address>' +
    '<ReferenceParameters xmlns="http://schemas.xmlsoap.org/ws/2004/08/addressing">' +
    '<ResourceURI xmlns="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd">http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_ComputerSystem</ResourceURI>' +
    '<SelectorSet xmlns="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd">' +
    '<Selector Name="CreationClassName">CIM_ComputerSystem</Selector>' +
    '<Selector Name="Name">ManagedSystem</Selector></SelectorSet></ReferenceParameters>'

  obj.RequestPowerStateChange = function (PowerState: number, cb: AmtObjectSink) {
    obj.Exec('CIM_PowerManagementService', 'RequestPowerStateChange', {
      PowerState,
      ManagedElement: COMPUTER_SYSTEM_REF,
    }, cb, 0, 1)
  }

  obj.RequestOSPowerStateChange = function (PowerState: number, cb: AmtObjectSink) {
    obj.Exec('IPS_PowerManagementService', 'RequestOSPowerSavingStateChange', {
      OSPowerSavingState: PowerState,
      ManagedElement: COMPUTER_SYSTEM_REF,
    }, cb, 0, 1)
  }

  obj.SetBootConfigRole = function (Role: string, cb: AmtObjectSink) {
    obj.Exec('CIM_BootService', 'SetBootConfigRole', {
      BootConfigSetting:
        '<Address xmlns="http://schemas.xmlsoap.org/ws/2004/08/addressing">http://schemas.xmlsoap.org/ws/2004/08/addressing</Address>' +
        '<ReferenceParameters xmlns="http://schemas.xmlsoap.org/ws/2004/08/addressing">' +
        '<ResourceURI xmlns="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd">http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_BootConfigSetting</ResourceURI>' +
        '<SelectorSet xmlns="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd">' +
        '<Selector Name="InstanceID">Intel(r) AMT:BootConfig:0</Selector>' +
        '<Selector Name="ChangeOfDefaultBootOption">Default</Selector>' +
        '<Selector Name="DefaultBootOption">Intel(r) AMT:BootConfig:0</Selector>' +
        '</SelectorSet></ReferenceParameters>',
      Role,
    }, cb, 0, 1)
  }

  obj.CancelAllQueries = function (s) {
    wsman.CancelAllQueries(s)
  }

  obj.AmtStatusCodes = {
    0x0000: 'SUCCESS',
    0x0001: 'INTERNAL_ERROR',
    0x0002: 'NOT_AUTHORIZED',
    0x0003: 'INVALID_PARAM',
    0x0004: 'FAILED',
    0x0005: 'REBOOT_REQUIRED',
    0x0006: 'INVALID_STATE',
    0x0007: 'NOT_IMPLEMENTED',
    0x0008: 'NOT_SUPPORTED',
    0x0009: 'BUSY',
    0x000a: 'PARTIAL_FAILURE',
    0x000b: 'DEVICE_NOT_PRESENT',
    0x000c: 'PLATFORM_NOT_SUPPORTED',
    0x000d: 'INVALID_KEY_LENGTH',
    0x000e: 'AGENT_NOT_PRESENT',
    0x000f: 'NOT_DETECTED',
    0x0010: 'RETRY_LATER',
    0x0011: 'RESOURCE_BUSY',
    0x0012: 'ACTION_NOT_SUPPORTED',
    0x0013: 'ACTION_IN_PROGRESS',
    0x0014: 'PERMISSION_DENIED',
    0x0015: 'MANAGEMENT_MODE_DISABLED',
    0x0016: 'PROVISIONING_MODE_DISABLED',
    0x0017: 'TIMEOUT',
    0x0018: 'NOT_READY',
    0x0019: 'DEVICE_NOT_CONNECTED',
    0x001a: 'CREDENTIAL_NOT_PROVIDED',
    0x001b: 'CREDENTIAL_INVALID',
    0x001c: 'CREDENTIAL_DISABLED',
    0x001d: 'CREDENTIAL_EXPIRED',
    0x001e: 'CREDENTIAL_NOT_RECOGNIZED',
    0x001f: 'CREDENTIAL_NOT_SUPPORTED',
    0x0020: 'CREDENTIAL_NOT_REVOKED',
    0x0021: 'CREDENTIAL_NOT_EXPIRED',
    0x0022: 'CREDENTIAL_NOT_ACTIVATED',
    0x0023: 'RTSP_NOT_SUPPORTED',
    0x0024: 'INVALID_ARGUMENT',
    0x0025: 'CERTIFICATE_EXPIRED',
    0x0026: 'CERTIFICATE_REVOKED',
    0x0027: 'CERTIFICATE_NOT_VALID',
    0x0028: 'INVALID_SUBJECT',
    0x0029: 'INVALID_ISSUER',
    0x002a: 'CRL_EXPIRED',
    0x002b: 'CRL_MISSING',
    0x002c: 'CERTIFICATE_REVOKED_BY_ISSUER',
    0x002d: 'BIND_CREDENTIALS_NOT_SUPPORTED',
    0x002e: 'INVALID_CONFIG',
    0x002f: 'NOT_ENOUGH_SPACE',
    0x0030: 'CERTIFICATE_NOT_FOUND',
    0x0031: 'INVALID_TIME',
    0x0032: 'INVALID_VERSION',
    0x0033: 'ENTITY_NOT_FOUND',
    0x0034: 'ENTITY_ALREADY_EXISTS',
    0x0035: 'CERTIFICATE_UNTRUSTED',
    0x0036: 'CERTIFICATE_REVOKED_BY_ADMINISTRATOR',
    0x0037: 'CERTIFICATE_ISSUED_BY_SELF_SIGNED_CA',
    0x0038: 'CERTIFICATE_VALIDITY_PERIOD_EXPIRED',
    0x0039: 'CERTIFICATE_REVOKED_BY_USER',
    0x003a: 'PARTIAL_FAILURE_2',
    0x003b: 'UNSUPPORTED_PARAMETER',
    0x003c: 'AUTHENTICATION_FAILED',
    0x003d: 'CERTIFICATE_NAME_NOT_FOUND',
    0x003e: 'CERTIFICATE_NAME_MISMATCH',
    0x003f: 'CERTIFICATE_NAME_MISMATCH_TOOLONG',
  }

  obj.AmtStatusToStr = function (code) {
    return obj.AmtStatusCodes[code] ?? 'UNKNOWN_ERROR'
  }

  return obj
}

/**
 * Convert a structured method argument into body XML. Used by the WiFi settings
 * calls, whose payload is a nested CIM instance rather than a flat value.
 */
function execArgumentsToXml(args: WsmanNode): string {
  if (!args) return ''
  let result = ''
  for (const argName in args) {
    const arg = args[argName]
    if (!arg || typeof arg === 'function') continue
    const a = arg as WsmanNode
    if (a['__parameterType'] === 'reference') {
      result += referenceToXml(argName, a)
    } else {
      const ns = a['__namespace'] as string | undefined
      const open = ns ? 'q:' : ''
      const nsDecl = ns ? ` xmlns:q="${ns}"` : ''
      let body = typeof arg === 'string' ? arg : ''
      if (typeof arg !== 'string') {
        for (const prop in a) {
          if (prop.startsWith('__')) continue
          const v = a[prop]
          if (typeof v === 'function' || Array.isArray(v) || v == null) continue
          body += `<${open}${prop}>${v}</${open}${prop}>`
        }
      }
      result += `<r:${argName}${nsDecl}>${body}</r:${argName}>`
    }
  }
  return result
}

function referenceToXml(referenceName: string, inReference: WsmanNode): string {
  let result =
    '<r:' + referenceName + '><a:Address>/wsman</a:Address><a:ReferenceParameters><w:ResourceURI>' +
    (inReference['__resourceUri'] as string) +
    '</w:ResourceURI><w:SelectorSet>'
  for (const selectorName in inReference) {
    if (selectorName.startsWith('__')) continue
    const v = inReference[selectorName]
    if (typeof v !== 'string' && typeof v !== 'number') continue
    result += '<w:Selector Name="' + selectorName + '">' + v + '</w:Selector>'
  }
  return result + '</w:SelectorSet></a:ReferenceParameters></r:' + referenceName + '>'
}

/** String replacement with `{0}`-style placeholders, matching the legacy `format()`. */
export function format(template: string, ...args: (string | number)[]): string {
  return template.replace(/\{(\d+)\}/g, (m, g) => {
    const v = args[parseInt(g, 10)]
    return v === undefined ? m : String(v)
  })
}

/** Unused import guard: SelectorSet is part of the public Exec* signature surface. */
export type { SelectorSet }