import { render } from 'preact'
import { App } from './app.tsx'
import { connect } from './state/device'

// Connect before the first render: pages pull from the stack in their mount
// effect, so the stack has to exist before any page runs.
connect()
render(<App />, document.getElementById('app')!)
