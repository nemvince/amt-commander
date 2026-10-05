/**
 * Dense data table, replacing the legacy TableStart/TableEnd string builders.
 * Title bar carries the optional refresh / add / clear affordances that the
 * legacy AddButton / AddRefreshButton helpers used to render.
 */
import type { ComponentChildren } from 'preact'
import { S } from '../strings'
import { AddIcon, RefreshIcon, TrashIcon } from './icons'

export interface Column {
  label: string
  /** Cell content for one row. */
  cell: (row: never) => ComponentChildren
  /** Right-align numeric columns. */
  numeric?: boolean
}

export interface TableProps<T> {
  title?: string
  columns: Column[]
  rows: T[]
  keyOf: (row: T) => string
  onRefresh?: () => void
  onAdd?: () => void
  onClear?: () => void
  /** Rendered under the table, used for paging / detail links. */
  footer?: ComponentChildren
  empty?: string
  /**
   * Still fetching. Distinguishes "nothing yet" from "nothing there", so an
   * empty table does not read as a real answer while the request is in flight.
   */
  loading?: boolean
}

export function Table<T>(props: TableProps<T>) {
  const showToolbar = props.title != null || props.onRefresh || props.onAdd || props.onClear
  return (
    <section class="table-panel">
      {showToolbar && (
        <div class="table-titlebar">
          {props.title != null && <h2 class="table-title">{props.title}</h2>}
          <div class="table-actions">
            {props.onRefresh && (
              <button type="button" class="btn btn-icon" onClick={props.onRefresh} title={S.refresh}>
                <RefreshIcon />
              </button>
            )}
            {props.onAdd && (
              <button type="button" class="btn btn-icon" onClick={props.onAdd} title={S.add}>
                <AddIcon />
              </button>
            )}
            {props.onClear && (
              <button type="button" class="btn btn-icon" onClick={props.onClear} title={S.clear}>
                <TrashIcon />
              </button>
            )}
          </div>
        </div>
      )}
      {props.rows.length === 0 ? (
        <p class={'table-empty' + (props.loading === true ? ' table-loading' : '')}>
          {props.loading === true ? S.loading : (props.empty ?? S.noData)}
        </p>
      ) : (
        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr>
                {props.columns.map((c) => (
                  <th key={c.label} class={c.numeric ? 'num' : undefined}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {props.rows.map((row) => (
                <tr key={props.keyOf(row)}>
                  {props.columns.map((c) => (
                    <td key={c.label} class={c.numeric ? 'num' : undefined}>
                      {c.cell(row as never)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {props.footer}
    </section>
  )
}