/**
 * User Accounts (view 11).
 *
 * Ported from the legacy ###BEGIN###{UserAccounts} region (index.html:8177-8364):
 * enumerate ACL handles, resolve each one with GetUserAclEntryEx, and keep the
 * enabled state alongside it so an account can be toggled without a re-read.
 *
 * AMT stores the digest itself: the password never leaves the browser in clear,
 * only md5(user:realm:password) does. The browser's own 401 challenge for the
 * console connection is the transport's business, not this page's -- this page
 * only ever hashes a password the user is creating or rotating.
 */
import { useEffect, useState } from 'preact/hooks'
import '../styles/users.css'
import { format } from '../lib/amt-stack'
import { digestPassword } from '../lib/md5'
import { getSidString, sidToBytes } from '../lib/sid'
import { PullAccounts, accounts, connState, generalSettings, getStack, pending } from '../state/device'
import { S, REALM_NAMES } from '../strings'
import { Dialog } from '../ui/dialog'
import { Table, type Column } from '../ui/table'
import type { WsmanNode } from '../lib/wsman'

/** AccessPermission, verbatim from the legacy picker (index.html:1314). */
const PERMISSIONS = ['Local only', 'Network only', 'All (Local & Network)']

/**
 * AMT reports AccessPermission 4 for "all", which the legacy index-based array
 * predates; show the same label rather than a bare number.
 */
function permissionName(p: number): string {
  return PERMISSIONS[p] ?? (p > 2 ? PERMISSIONS[2] : String(p))
}

/** Realm 3 is Administrator and realm 20 is Auditor (index.html:8249). */
const REALM_ADMIN = 3
const REALM_AUDITOR = 20

const REALM_OPTIONS = REALM_NAMES.map((name, id) => ({ id, name })).filter((r) => r.name !== '')

interface Entry {
  /** -1 for the built-in admin account, 0 only while creating a new one. */
  handle: number
  name: string
  admin: boolean
  hidden: boolean
  permission: number
  realms: (number | string)[]
  enabled: boolean | null
}

interface Form {
  handle: number
  admin: boolean
  username: string
  password: string
  confirm: string
  permission: number
  realms: number[]
}

const EMPTY_FORM: Form = {
  handle: 0,
  admin: false,
  username: '',
  password: '',
  confirm: '',
  permission: 2,
  realms: [],
}

export function UsersPage() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [form, setForm] = useState<Form | null>(null)
  const [detail, setDetail] = useState<Entry | null>(null)
  const [removing, setRemoving] = useState<Entry | null>(null)
  const [showHidden, setShowHidden] = useState(false)

  // Re-render when the pull lands, then resolve each handle into a full entry.
  // Both waits are on signals read in the body, so a page opened before the
  // device finished connecting still fills in.
  const listed = accounts.value
  const conn = connState.value
  useEffect(() => {
    if (conn === 'connected') PullAccounts()
  }, [conn])
  useEffect(() => {
    if (conn === 'connected') loadAccounts(listed)
  }, [conn, listed])

  function loadAccounts(list: WsmanNode[]) {
    const stack = getStack()
    if (stack == null) return
    const next: Entry[] = []
    stack.Exec('AMT_AuthorizationService', 'GetAdminAclEntry', {}, (_s, _n, resp) => {
      const name = String(resp?.Body?.['Username'] ?? '')
      if (name !== '') {
        next.push({ handle: -1, name, admin: true, hidden: false, permission: 999, realms: [], enabled: null })
      }
      setEntries(next.slice())
      for (const handle of handlesOf(list)) {
        stack.Exec('AMT_AuthorizationService', 'GetUserAclEntryEx', { Handle: handle }, (_s2, _n2, entry) => {
          if (entry?.Body != null) next.push(toEntry(handle, entry.Body))
          setEntries(next.slice())
        })
        stack.Exec('AMT_AuthorizationService', 'GetAclEnabledState', { Handle: handle }, (_s2, _n2, state) => {
          const i = next.findIndex((e) => e.handle === handle)
          if (i < 0) return
          // Some devices (and older firmware) omit Enabled entirely; leave it unknown.
          const on = state?.Body?.['Enabled']
          next[i] = { ...next[i], enabled: on === undefined ? null : on === true }
          setEntries(next.slice())
        })
      }
    })
  }

  const reload = () => PullAccounts()

  const startAdd = () => setForm({ ...EMPTY_FORM })

  const startEdit = (e: Entry) =>
    setForm({
      handle: e.handle,
      admin: e.admin,
      username: e.name,
      password: '',
      confirm: '',
      permission: e.permission === 999 ? 0 : e.permission,
      realms: e.realms.filter((r) => /^\d+$/.test(String(r))).map(Number),
    })

  const toggleEnabled = (e: Entry) => {
    const stack = getStack()
    if (stack == null || e.enabled == null) return
    stack.Exec('AMT_AuthorizationService', 'SetAclEnabledState', { Handle: e.handle, Enabled: !e.enabled }, () => {
      const i = entries.findIndex((x) => x.handle === e.handle)
      if (i >= 0) setEntries(entries.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)))
    })
  }

  const remove = () => {
    const stack = getStack()
    const target = removing
    setRemoving(null)
    if (stack == null || target == null) return
    stack.Exec('AMT_AuthorizationService', 'RemoveUserAclEntry', { Handle: target.handle }, () => reload())
  }

  const canSubmit =
    form != null &&
    form.username.length > 0 &&
    passwordOk(form.password) &&
    form.password === form.confirm &&
    (form.admin || form.realms.length > 0)

  const submit = () => {
    const stack = getStack()
    const f = form
    setForm(null)
    if (stack == null || f == null || !canSubmit) return

    const realm = String(generalSettings.value?.['DigestRealm'] ?? '')
    // AMT wants the raw digest as base64, which is what the legacy btoa(rstr_md5()) did.
    const digest = btoa(
      digestPassword(f.username, realm, f.password).replace(/../g, (b) => String.fromCharCode(parseInt(b, 16))),
    )
    // A username shaped like S-1-5-... is a Kerberos account, so it goes in as a SID.
    const sid = sidToBytes(f.username)
    const done = () => reload()

    if (f.admin) {
      stack.Exec('AMT_AuthorizationService', 'SetAdminAclEntryEx', { Username: f.username, DigestPassword: digest }, done)
      return
    }
    const args: WsmanNode = {
      DigestUsername: sid == null ? f.username : undefined,
      DigestPassword: sid == null ? digest : undefined,
      KerberosUserSid: sid == null ? undefined : btoa(sid),
      AccessPermission: f.permission,
      Realms: f.realms,
    }
    if (f.handle === 0) stack.Exec('AMT_AuthorizationService', 'AddUserAclEntryEx', args, done)
    else stack.Exec('AMT_AuthorizationService', 'UpdateUserAclEntryEx', { Handle: f.handle, ...args }, done)
  }

  const rows = entries.filter((e) => showHidden || !e.hidden)

  const columns: Column[] = [
    {
      label: S.username,
      cell: (e: Entry) => (
        <a href="#" onClick={(ev) => { ev.preventDefault(); setDetail(e) }}>
          {e.name}
        </a>
      ),
    },
    { label: S.permission, cell: (e: Entry) => (e.admin ? S.administrator : permissionName(e.permission)) },
    { label: S.realm, cell: (e: Entry) => realmSummary(e) },
    {
      label: S.enabled,
      cell: (e: Entry) =>
        e.enabled == null ? (
          '—'
        ) : e.enabled ? (
          <span class="status-ok">{S.enabled}</span>
        ) : (
          <span class="status-warn">{S.disabled}</span>
        ),
    },
    {
      label: S.actions,
      cell: (e: Entry) => (
        <span class="btn-row" style="padding:0">
          {e.enabled != null && (
            <button type="button" class="btn" onClick={() => toggleEnabled(e)}>
              {e.enabled ? S.disable : S.enable}
            </button>
          )}
          <button type="button" class="btn" onClick={() => startEdit(e)}>
            {S.edit}
          </button>
          {!e.admin && (
            <button type="button" class="btn" onClick={() => setRemoving(e)}>
              {S.remove}
            </button>
          )}
        </span>
      ),
    },
  ]

  return (
    <div class="page">
      <Table loading={pending.value > 0}
        title={S.navUsers}
        columns={columns}
        rows={rows}
        keyOf={(e) => String(e.handle)}
        onRefresh={reload}
        onAdd={startAdd}
        empty={S.noAccounts}
        footer={
          <div class="btn-row">
            <button type="button" class="btn" onClick={() => setShowHidden((v) => !v)}>
              {showHidden ? S.hideHiddenAccounts : S.showHiddenAccounts}
            </button>
          </div>
        }
      />

      {form != null && (
        <Dialog
          title={form.handle === 0 ? S.addUser : S.updateUser}
          onClose={(v) => (v === 'ok' ? submit() : setForm(null))}
          buttons={[
            { label: S.ok, value: 'ok', primary: true },
            { label: S.cancel, value: 'cancel' },
          ]}
        >
          <div class="field-row">
            <label>
              {S.username}
              <input type="text" value={form.username} onInput={(e) => setForm({ ...form, username: e.currentTarget.value })} />
            </label>
            <label>
              {S.password}
              <input type="password" value={form.password} onInput={(e) => setForm({ ...form, password: e.currentTarget.value })} />
            </label>
            <label>
              {S.confirmPassword}
              <input type="password" value={form.confirm} onInput={(e) => setForm({ ...form, confirm: e.currentTarget.value })} />
            </label>
            {!form.admin && (
              <label>
                {S.permission}
                <select value={String(form.permission)} onChange={(e) => setForm({ ...form, permission: Number(e.currentTarget.value) })}>
                  {PERMISSIONS.map((p, i) => (
                    <option key={p} value={String(i)}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {!form.admin && (
            <>
              <div class="table-titlebar">
                <h2 class="table-title">{S.grantedPermissions}</h2>
              </div>
              <div class="realm-list">
                <label>
                  <input type="checkbox" checked={form.realms.includes(REALM_ADMIN)} onChange={() => setForm(toggleRealm(form, REALM_ADMIN))} />
                  {S.administrator}
                </label>
                {REALM_OPTIONS.map((r) => (
                  <label key={r.id}>
                    <input type="checkbox" checked={form.realms.includes(r.id)} onChange={() => setForm(toggleRealm(form, r.id))} />
                    {r.name}
                  </label>
                ))}
              </div>
            </>
          )}

          <p class="hint">{S.passwordRules}</p>
        </Dialog>
      )}

      {detail != null && (
        <Dialog title={format(S.accountDetails, detail.name)} onClose={() => setDetail(null)} buttons={[{ label: S.close, value: 'cancel' }]}>
          <dl class="kv">
            <dt>{S.username}</dt>
            <dd class="mono">{detail.name}</dd>
            {detail.enabled != null && (
              <>
                <dt>{S.enabled}</dt>
                <dd>{detail.enabled ? S.enabled : S.disabled}</dd>
              </>
            )}
            <dt>{S.permission}</dt>
            <dd>{detail.admin ? S.administrator : permissionName(detail.permission)}</dd>
            {!detail.admin && (
              <>
                <dt>{S.realm}</dt>
                <dd>{realmSummary(detail)}</dd>
              </>
            )}
          </dl>
        </Dialog>
      )}

      {removing != null && (
        <Dialog
          title={S.removeUser}
          onClose={(v) => (v === 'ok' ? remove() : setRemoving(null))}
          buttons={[
            { label: S.ok, value: 'ok', primary: true },
            { label: S.cancel, value: 'cancel' },
          ]}
        >
          <p>{format(S.removeUserConfirm, removing.name)}</p>
        </Dialog>
      )}
    </div>
  )
}

/** Enumerate hands back handles, 1-based and sequential; tolerate a bare index. */
function handlesOf(list: WsmanNode[]): number[] {
  return list.map((e, i) => {
    const h = e != null && typeof e === 'object' && !Array.isArray(e) ? Number(e['Handle']) : NaN
    return Number.isFinite(h) && h > 0 ? h : i + 1
  })
}

function toEntry(handle: number, body: WsmanNode): Entry {
  const digest = String(body['DigestUsername'] ?? '')
  const sid = String(body['KerberosUserSid'] ?? '')
  let name = digest
  if (name === '' && sid !== '') {
    try {
      name = getSidString(atob(sid))
    } catch {
      name = sid
    }
  }
  if (name === '') name = '#' + handle
  const raw = body['Realms']
  return {
    handle,
    name,
    admin: false,
    hidden: name.startsWith('$$'),
    permission: Number(body['AccessPermission'] ?? 0),
    realms: (Array.isArray(raw) ? raw : raw == null ? [] : [raw]) as (number | string)[],
    enabled: null,
  }
}

function toggleRealm(form: Form, realm: number): Form {
  const realms = form.realms.includes(realm) ? form.realms.filter((r) => r !== realm) : [...form.realms, realm]
  return { ...form, realms }
}

function realmSummary(entry: Entry): string {
  if (entry.admin) return S.administrator
  if (entry.realms.includes(REALM_ADMIN)) {
    return entry.realms.includes(REALM_AUDITOR) ? S.administrator + ', ' + S.auditor : S.administrator
  }
  const names = entry.realms.map((r) => REALM_NAMES[Number(r)] ?? String(r)).filter((n) => n !== '')
  if (names.length === 0) return S.none
  return names.length === 1 ? names[0] : format(S.manyRealms, names.length)
}

/** Legacy passwordcheck (index.html:14017): 8+ chars, upper, lower, digit, symbol. */
function passwordOk(p: string): boolean {
  if (p.length < 8) return false
  let upper = false
  let lower = false
  let digit = false
  let other = false
  for (const ch of p) {
    const c = ch.charCodeAt(0)
    if (c > 64 && c < 91) upper = true
    else if (c > 96 && c < 123) lower = true
    else if (c > 47 && c < 58) digit = true
    else other = true
  }
  return upper && lower && digit && other
}
