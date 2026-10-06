import { render } from 'preact'
import 'virtual:theme.css'
import { App } from './app.tsx'
import { connect } from './state/device'

// The theme file is scoped to `:root[data-theme="..."]`, so one attribute turns
// it on. In development every theme is loaded and the overlay flips this value.
document.documentElement.dataset.theme = __THEME__

// Connect before the first render: pages pull from the stack in their mount
// effect, so the stack has to exist before any page runs.
connect()
render(<App />, document.getElementById('app')!)
