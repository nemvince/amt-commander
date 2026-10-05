/**
 * Labelled key/value panel. The hardware and network pages each had their own
 * identical copy of this component -- markup, props and all -- so it lives here
 * now that a layout fix only has to be made once.
 */
export type Field = [string, string]

export function Details(props: { title: string; fields: Field[] }) {
  return (
    <section class="table-panel">
      <div class="table-titlebar">
        <h2 class="table-title">{props.title}</h2>
      </div>
      <dl class="kv">
        {props.fields.map(([label, value]) => (
          <>
            <dt>{label}</dt>
            <dd class="mono">{value === '' ? '—' : value}</dd>
          </>
        ))}
      </dl>
    </section>
  )
}
