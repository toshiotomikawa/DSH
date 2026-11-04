// Native process fixture: no network, model, credentials or desktop interaction.
import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const mode = process.env.M4_FIXTURE_MODE
if (mode === 'hang') {
  writeFileSync(process.env.M4_PID_FILE, String(process.pid))
  setInterval(()=>{},1000)
} else {
  if (mode === 'orphan') {
    // Final answer first, then a detached grandchild that outlives this process.
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore', windowsHide: true })
    writeFileSync(process.env.M4_PID_FILE, String(grandchild.pid))
    grandchild.unref()
  }
  const text=process.env.M4_SECRET_TOKEN === undefined && process.env.M4_CUSTOM_AUTH === undefined ? 'SCRUBBED' : 'LEAK'
  process.stdout.write(JSON.stringify(mode === 'agy' ? {event:'result',result:{status:'SUCCESS',response:text}} : {text,stopReason:'end_turn'}))
}
