/**
 * WSMAN transport + SOAP layer.
 *
 * Ported from amt-wsman-ajax-0.2.0.js (browser XHR transport) and the SOAP
 * operations of amt-wsman-0.2.0.js. Request XML stays byte-compatible with the
 * legacy templates so real AMT firmware accepts the exact same envelopes.
 *
 * XHR (not fetch) is deliberate: the browser's native digest 401 dialog only
 * fires for XHR. Firmware mode does no client-side digest, it lets the browser
 * prompt for credentials exactly as the legacy app did.
 */

export type WsmanValue = string | number | boolean | WsmanNode | WsmanValue[]
export interface WsmanNode {
  [key: string]: WsmanValue | undefined
}

export interface WsmanResponse {
  Header: Record<string, WsmanValue> & {
    HttpError?: number
    WsmanError?: string
  }
  Body?: WsmanNode
}

/** Raw transport callback: hands back the unparsed response text and HTTP status. */
export type RawCallback = (data: string | null, status: number, tag: unknown) => void

type PendingCall = [
  string,
  RawCallback,
  unknown,
  string | undefined,
  string | undefined,
  Uint8Array<ArrayBuffer> | undefined,
]

export interface WsmanComm {
  Url: string
  PendingAjax: PendingCall[]
  ActiveAjaxCount: number
  MaxActiveAjaxCount: number
  /** Non-zero: fail every call with this status. 999 = stay silent (disconnect path). */
  FailAllError: number
  PerformAjax(
    postdata: string,
    callback: RawCallback,
    tag: unknown,
    pri: number,
    url?: string,
    action?: string,
    /**
     * Raw request bytes, used instead of `postdata` when present. The installer
     * PUTs gzip, which `postdata` -- a string -- cannot carry. Pinned to
     * `ArrayBuffer` because that is what `XMLHttpRequest.send` accepts.
     */
    body?: Uint8Array<ArrayBuffer>,
  ): void
  CancelAllQueries(s: number): void
}

/** Port of CreateWsmanComm(). One in-flight XHR at a time, priority calls jump the queue. */
export function createWsmanComm(url: string): WsmanComm {
  const obj: WsmanComm = {
    Url: url,
    PendingAjax: [],
    ActiveAjaxCount: 0,
    MaxActiveAjaxCount: 1,
    FailAllError: 0,
    CancelAllQueries(s) {
      while (obj.PendingAjax.length > 0) {
        const x = obj.PendingAjax.shift()!
        x[1](null, s, x[2])
      }
    },
    PerformAjax(postdata, callback, tag, pri, url, action, body) {
      if (obj.ActiveAjaxCount === 0 && obj.PendingAjax.length === 0) {
        performAjaxEx(postdata, callback, tag, url, action, body)
      } else if (pri === 1) {
        obj.PendingAjax.unshift([postdata, callback, tag, url, action, body])
      } else {
        obj.PendingAjax.push([postdata, callback, tag, url, action, body])
      }
    },
  }

  function performNext() {
    if (obj.ActiveAjaxCount >= obj.MaxActiveAjaxCount || obj.PendingAjax.length === 0) return
    const x = obj.PendingAjax.shift()!
    performAjaxEx(x[0], x[1], x[2], x[3], x[4], x[5])
  }

  function performAjaxEx(
    postdata: string,
    callback: RawCallback,
    tag: unknown,
    url: string | undefined,
    action: string | undefined,
    body: Uint8Array<ArrayBuffer> | undefined,
  ) {
    if (obj.FailAllError !== 0) {
      if (obj.FailAllError !== 999) callback(null, obj.FailAllError, tag)
      return
    }
    obj.ActiveAjaxCount++
    const xdr = new XMLHttpRequest()
    xdr.open(action ? action : 'POST', url ? url : obj.Url)
    xdr.timeout = 15000
    xdr.onload = () => {
      obj.ActiveAjaxCount--
      if (obj.FailAllError === 999) return
      callback(xdr.responseText, xdr.status, tag)
      performNext()
    }
    xdr.onerror = xdr.ontimeout = () => {
      obj.ActiveAjaxCount--
      if (obj.FailAllError === 999) return
      callback(null, xdr.status, tag)
      performNext()
    }
    /*
     * Send as bytes: a body given by the caller is already bytes (the installer's
     * gzip), otherwise the string is UTF-8 XML and must survive multi-byte chars.
     */
    const bytes = body ?? new TextEncoder().encode(postdata ?? '')
    xdr.send(bytes)
  }

  return obj
}

const ENVELOPE_OPEN =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
  ' xmlns:xsd="http://www.w3.org/2001/XMLSchema"' +
  ' xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"' +
  ' xmlns:w="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd"' +
  ' xmlns="http://www.w3.org/2003/05/soap-envelope" '

const ANON_REPLY_TO = '<a:ReplyTo><a:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo>'

export interface SelectorSet {
  [selector: string]: string | WsmanEndpoint
}

export interface WsmanEndpoint {
  Address: string
  ReferenceParameters: {
    ResourceURI: string
    SelectorSet: { Selector: WsmanSelector | WsmanSelector[] }
  }
}

export interface WsmanSelector {
  Value: string
  [attr: string]: string
}
/** Sink signature every Exec* method invokes on completion. */
export type WsmanSink = (
  ws: Wsman,
  resuri: string | undefined,
  response: WsmanResponse | null,
  status: number,
  tag: unknown,
) => void

export interface Wsman {
  Address: string
  NextMessageId: number
  comm: WsmanComm
  PerformAjax(postdata: string, callback: WsmanSink, tag: unknown, pri: number, namespaces?: string): void
  CancelAllQueries(s: number): void
  GetNameFromUrl(resuri: string): string
  ExecSubscribe(
    resuri: string,
    delivery: string,
    url: string,
    callback: WsmanSink,
    tag: unknown,
    pri: number,
    selectors?: SelectorSet,
    opaque?: string,
  ): void
  ExecUnSubscribe(resuri: string, callback: WsmanSink, tag: unknown, pri: number, selectors?: SelectorSet): void
  ExecPut(
    resuri: string,
    putobj: WsmanNode,
    callback: WsmanSink,
    tag: unknown,
    pri: number,
    selectors?: SelectorSet,
  ): void
  ExecCreate(resuri: string, putobj: WsmanNode, callback: WsmanSink, tag: unknown, pri: number): void
  ExecDelete(resuri: string, putobj: SelectorSet, callback: WsmanSink, tag: unknown, pri: number): void
  ExecGet(resuri: string, callback: WsmanSink, tag: unknown, pri: number): void
  ExecMethod(
    resuri: string,
    method: string,
    args: WsmanNode,
    callback: WsmanSink,
    tag: unknown,
    pri: number,
    selectors?: SelectorSet,
  ): void
  ExecMethodXml(
    resuri: string,
    method: string,
    argsxml: string,
    callback: WsmanSink,
    tag: unknown,
    pri: number,
    selectors?: SelectorSet,
  ): void
  ExecEnum(resuri: string, callback: WsmanSink, tag: unknown, pri: number): void
  ExecPull(resuri: string, enumctx: string, callback: WsmanSink, tag: unknown, pri: number): void
}

/** Port of WsmanStackCreateService()'s SOAP half. */
export function createWsmanStack(url: string): Wsman {
  const obj: Wsman = {
    Address: '/wsman',
    NextMessageId: 1,
    comm: createWsmanComm(url),

    PerformAjax(postdata, callback, tag, pri, namespaces) {
      obj.comm.PerformAjax(
        ENVELOPE_OPEN + (namespaces ?? '') + '><Header><a:Action>' + postdata,
        (data, status, t) => {
          let wsresponse = parseWsman(data)
          if (data != null && wsresponse == null && status === 200) {
            callback(obj, undefined, { Header: { HttpError: status } }, 601, t)
          } else {
            if (status !== 200) {
              if (wsresponse == null) wsresponse = { Header: {} }
              wsresponse.Header.HttpError = status
              const reason = wsresponse.Body?.['Reason'] as WsmanNode | undefined
              try {
                wsresponse.Header.WsmanError = (reason?.['Text'] as WsmanNode)?.['Value'] as string
              } catch {
                /* no Reason element */
              }
            }
            callback(obj, wsresponse?.Header?.['ResourceURI'] as string, wsresponse, status, t)
          }
        },
        tag,
        pri,
      )
    },

    CancelAllQueries(s) {
      obj.comm.CancelAllQueries(s)
    },

    GetNameFromUrl(resuri) {
      const x = resuri.lastIndexOf('/')
      return x === -1 ? resuri : resuri.substring(x + 1)
    },

    ExecSubscribe(resuri, delivery, url, callback, tag, pri, selectors, opaque) {
      let d = ''
      if (delivery === 'PushWithAck') d = 'dmtf.org/wbem/wsman/1/wsman/PushWithAck'
      else if (delivery === 'Push') d = 'xmlsoap.org/ws/2004/08/eventing/DeliveryModes/Push'
      const op = opaque ? `<a:ReferenceParameters><m:arg>${opaque}</m:arg></a:ReferenceParameters>` : ''
      obj.PerformAjax(
        'http://schemas.xmlsoap.org/ws/2004/08/eventing/Subscribe</a:Action><a:To>' +
          obj.Address +
          '</a:To><w:ResourceURI>' +
          resuri +
          '</w:ResourceURI><a:MessageID>' +
          obj.NextMessageId++ +
          '</a:MessageID>' +
          ANON_REPLY_TO +
          putObjToSelectorsXml(selectors as SelectorSet) +
          '</Header><Body><e:Subscribe><e:Delivery Mode="http://schemas.' +
          d +
          '"><e:NotifyTo><a:Address>' +
          url +
          '</a:Address>' +
          op +
          '</e:NotifyTo></e:Delivery></e:Subscribe>',
        callback,
        tag,
        pri,
        'xmlns:e="http://schemas.xmlsoap.org/ws/2004/08/eventing" xmlns:m="http://x.com"',
      )
    },

    ExecUnSubscribe(resuri, callback, tag, pri, selectors) {
      obj.PerformAjax(
        'http://schemas.xmlsoap.org/ws/2004/08/eventing/Unsubscribe</a:Action><a:To>' +
          obj.Address +
          '</a:To><w:ResourceURI>' +
          resuri +
          '</w:ResourceURI><a:MessageID>' +
          obj.NextMessageId++ +
          '</a:MessageID>' +
          ANON_REPLY_TO +
          putObjToSelectorsXml(selectors as SelectorSet) +
          '</Header><Body><e:Unsubscribe/>',
        callback,
        tag,
        pri,
        'xmlns:e="http://schemas.xmlsoap.org/ws/2004/08/eventing"',
      )
    },

    ExecPut(resuri, putobj, callback, tag, pri, selectors) {
      obj.PerformAjax(
        'http://schemas.xmlsoap.org/ws/2004/09/transfer/Put</a:Action><a:To>' +
          obj.Address +
          '</a:To><w:ResourceURI>' +
          resuri +
          '</w:ResourceURI><a:MessageID>' +
          obj.NextMessageId++ +
          '</a:MessageID>' +
          ANON_REPLY_TO +
          '<w:OperationTimeout>PT60.000S</w:OperationTimeout>' +
          putObjToSelectorsXml(selectors as SelectorSet) +
          '</Header><Body>' +
          putObjToBodyXml(resuri, putobj as WsmanNode),
        callback,
        tag,
        pri,
      )
    },

    ExecCreate(resuri, putobj, callback, tag, pri) {
      const objname = obj.GetNameFromUrl(resuri)
      let data =
        'http://schemas.xmlsoap.org/ws/2004/09/transfer/Create</a:Action><a:To>' +
        obj.Address +
        '</a:To><w:ResourceURI>' +
        resuri +
        '</w:ResourceURI><a:MessageID>' +
        obj.NextMessageId++ +
        '</a:MessageID>' +
        ANON_REPLY_TO +
        '<w:OperationTimeout>PT60S</w:OperationTimeout></Header><Body><g:' +
        objname +
        ' xmlns:g="' +
        resuri +
        '">'
      const src = putobj as Record<string, WsmanValue>
      for (const n in src) data += '<g:' + n + '>' + src[n] + '</g:' + n + '>'
      obj.PerformAjax(data + '</g:' + objname + '></Body></Envelope>', callback, tag, pri)
    },

    ExecDelete(resuri, putobj, callback, tag, pri) {
      obj.PerformAjax(
        'http://schemas.xmlsoap.org/ws/2004/09/transfer/Delete</a:Action><a:To>' +
          obj.Address +
          '</a:To><w:ResourceURI>' +
          resuri +
          '</w:ResourceURI><a:MessageID>' +
          obj.NextMessageId++ +
          '</a:MessageID>' +
          ANON_REPLY_TO +
          '<w:OperationTimeout>PT60S</w:OperationTimeout>' +
          putObjToSelectorsXml(putobj as SelectorSet) +
          '</Header><Body /></Envelope>',
        callback,
        tag,
        pri,
      )
    },

    ExecGet(resuri, callback, tag, pri) {
      obj.PerformAjax(
        'http://schemas.xmlsoap.org/ws/2004/09/transfer/Get</a:Action><a:To>' +
          obj.Address +
          '</a:To><w:ResourceURI>' +
          resuri +
          '</w:ResourceURI><a:MessageID>' +
          obj.NextMessageId++ +
          '</a:MessageID>' +
          ANON_REPLY_TO +
          '<w:OperationTimeout>PT60S</w:OperationTimeout></Header><Body /></Envelope>',
        callback,
        tag,
        pri,
      )
    },

    ExecMethod(resuri, method, args, callback, tag, pri, selectors) {
      let argsxml = ''
      const a = args as Record<string, WsmanValue>
      for (const i in a) {
        if (a[i] == null) continue
        if (Array.isArray(a[i])) {
          for (const x of a[i] as WsmanValue[]) argsxml += '<r:' + i + '>' + x + '</r:' + i + '>'
        } else {
          argsxml += '<r:' + i + '>' + a[i] + '</r:' + i + '>'
        }
      }
      obj.ExecMethodXml(resuri, method, argsxml, callback, tag, pri, selectors)
    },

    ExecMethodXml(resuri, method, argsxml, callback, tag, pri, selectors) {
      obj.PerformAjax(
        resuri +
          '/' +
          method +
          '</a:Action><a:To>' +
          obj.Address +
          '</a:To><w:ResourceURI>' +
          resuri +
          '</w:ResourceURI><a:MessageID>' +
          obj.NextMessageId++ +
          '</a:MessageID>' +
          ANON_REPLY_TO +
          '<w:OperationTimeout>PT60S</w:OperationTimeout>' +
          putObjToSelectorsXml(selectors as SelectorSet) +
          '</Header><Body><r:' +
          method +
          '_INPUT xmlns:r="' +
          resuri +
          '">' +
          argsxml +
          '</r:' +
          method +
          '_INPUT></Body></Envelope>',
        callback,
        tag,
        pri,
      )
    },

    ExecEnum(resuri, callback, tag, pri) {
      obj.PerformAjax(
        'http://schemas.xmlsoap.org/ws/2004/09/enumeration/Enumerate</a:Action><a:To>' +
          obj.Address +
          '</a:To><w:ResourceURI>' +
          resuri +
          '</w:ResourceURI><a:MessageID>' +
          obj.NextMessageId++ +
          '</a:MessageID>' +
          ANON_REPLY_TO +
          '<w:OperationTimeout>PT60S</w:OperationTimeout></Header><Body><Enumerate xmlns="http://schemas.xmlsoap.org/ws/2004/09/enumeration" /></Body></Envelope>',
        callback,
        tag,
        pri,
      )
    },

    ExecPull(resuri, enumctx, callback, tag, pri) {
      obj.PerformAjax(
        'http://schemas.xmlsoap.org/ws/2004/09/enumeration/Pull</a:Action><a:To>' +
          obj.Address +
          '</a:To><w:ResourceURI>' +
          resuri +
          '</w:ResourceURI><a:MessageID>' +
          obj.NextMessageId++ +
          '</a:MessageID>' +
          ANON_REPLY_TO +
          '<w:OperationTimeout>PT60S</w:OperationTimeout></Header><Body><Pull xmlns="http://schemas.xmlsoap.org/ws/2004/09/enumeration"><EnumerationContext>' +
          enumctx +
          '</EnumerationContext></Pull></Body></Envelope>',
        callback,
        tag,
        pri,
      )
    },
  }

  return obj
}

function objToXmlAttributes(o: WsmanSelector | undefined): string {
  if (!o) return ''
  let r = ''
  for (const prop in o) {
    if (!prop.startsWith('@')) continue
    r += ' ' + prop.substring(1) + '="' + String(o[prop]) + '"'
  }
  return r
}

function endpointToXml(ep: WsmanEndpoint): string {
  let r =
    '<a:Address>' +
    ep.Address +
    '</a:Address><a:ReferenceParameters><w:ResourceURI>' +
    ep.ReferenceParameters.ResourceURI +
    '</w:ResourceURI><w:SelectorSet>'
  const sel = ep.ReferenceParameters.SelectorSet.Selector
  for (const s of Array.isArray(sel) ? sel : [sel]) {
    r += '<w:Selector' + objToXmlAttributes(s) + '>' + s.Value + '</w:Selector>'
  }
  return r + '</w:SelectorSet></a:ReferenceParameters>'
}

function putObjToSelectorsXml(selectorSet: unknown): string {
  if (!selectorSet) return ''
  if (typeof selectorSet === 'string') return selectorSet
  const ss = selectorSet as SelectorSet
  if (ss['InstanceID']) {
    return '<w:SelectorSet><w:Selector Name="InstanceID">' + ss['InstanceID'] + '</w:Selector></w:SelectorSet>'
  }
  let result = '<w:SelectorSet>'
  for (const propName in ss) {
    const v = ss[propName]
    result += '<w:Selector Name="' + propName + '">'
    result += typeof v === 'object' && v && 'ReferenceParameters' in v ? '<a:EndpointReference>' + endpointToXml(v) + '</a:EndpointReference>' : String(v)
    result += '</w:Selector>'
  }
  return result + '</w:SelectorSet>'
}

function putObjToBodyXml(resuri: string, putObj: WsmanNode): string {
  if (!resuri || putObj == null) return ''
  const objname = resuri.substring(resuri.lastIndexOf('/') + 1)
  let result = '<r:' + objname + ' xmlns:r="' + resuri + '">'
  for (const prop in putObj) {
    if (prop.startsWith('__') || prop.startsWith('@')) continue
    const value = putObj[prop]
    if (value == null || typeof value === 'function') continue
    if (typeof value === 'object' && !Array.isArray(value) && 'ReferenceParameters' in value) {
      result += '<r:' + prop + '>' + endpointToXml(value as unknown as WsmanEndpoint) + '</r:' + prop + '>'
    } else if (Array.isArray(value)) {
      for (const v of value) result += '<r:' + prop + '>' + String(v) + '</r:' + prop + '>'
    } else {
      result += '<r:' + prop + '>' + String(value) + '</r:' + prop + '>'
    }
  }
  return result + '</r:' + objname + '>'
}

/** Recursively turn an XML element into the legacy plain-object shape. */
function parseWsmanRec(node: Element): WsmanNode {
  const r: WsmanNode = {}
  const children = node.children
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    let data: WsmanValue = child.childElementCount === 0 ? child.textContent ?? '' : parseWsmanRec(child)
    if (data === 'true') data = true
    else if (data === 'false') data = false
    if (/^-?\d+$/.test(data as string)) data = parseInt(data as string, 10)

    let childObj: WsmanValue = data
    if (child.attributes.length > 0) {
      const withAttrs: WsmanNode = { Value: data }
      for (let j = 0; j < child.attributes.length; j++) {
        withAttrs['@' + child.attributes[j].name] = child.attributes[j].value
      }
      childObj = withAttrs
    }

    const existing = r[child.localName]
    if (Array.isArray(existing)) existing.push(childObj)
    else if (existing === undefined) r[child.localName] = childObj
    else r[child.localName] = [existing, childObj]
  }
  return r
}

function parseWsman(xml: string | null): WsmanResponse | null {
  if (xml == null) return null
  const r: WsmanResponse = { Header: {} }
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml')
  } catch {
    return null
  }
  if (doc.getElementsByTagName('parsererror').length > 0) return null

  // Namespace-agnostic lookup: AMT prefixes every element (`<a:Header>`, `<g:Body>`),
  // and in an XML document getElementsByTagName matches the *qualified* name, so a
  // plain name lookup silently matches nothing and every response parses as null.
  const header = doc.getElementsByTagNameNS('*', 'Header')[0]
  if (!header) return null
  for (let i = 0; i < header.children.length; i++) {
    const child = header.children[i]
    r.Header[child.localName] = child.textContent ?? ''
  }
  const body = doc.getElementsByTagNameNS('*', 'Body')[0]
  if (!body) return null
  if (body.children.length > 0) {
    let t = body.children[0].localName
    if (t.endsWith('_OUTPUT')) t = t.substring(0, t.length - 7)
    r.Header['Method'] = t
    try {
      r.Body = parseWsmanRec(body.children[0])
    } catch {
      return null
    }
  }
  return r
}