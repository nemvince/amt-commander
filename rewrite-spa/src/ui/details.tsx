/**
 * Labelled key/value panel. The hardware and network pages each had their own
 * identical copy of this component -- markup, props and all -- so it lives here
 * now that a layout fix only has to be made once.
 */
import { S } from '../strings'

export type Field = [string, string]

export function Details(props: { title: string; fields: Field[]; loading?: boolean }) {
  return (
    <section class="table-panel">
      <div class="table-titlebar">
        <h2 class="table-title">{props.title}</h2>
      </div>
      {props.loading === true ? (
        <p class="table-empty table-loading">{S.loading}</p>
      ) : (
        <dl class="kv">
          {props.fields.map(([label, value]) => (
            <>
              <dt>{label}</dt>
              <dd class="mono">{value === '' ? '—' : value}</dd>
            </>
          ))}
        </dl>
      )}
    </section>
  )
}
