// Native process fixture: no network, model, credentials or desktop interaction.
import { writeFileSync } from 'node:fs'
const mode = process.env.M4_FIXTURE_MODE
if (mode === 'hang') {
  writeFileSync(process.env.M4_PID_FILE, String(process.pid))
  setInterval(()=>{},1000)
} else {
  const text=process.env.M4_SECRET_TOKEN === undefined ? 'SCRUBBED' : 'LEAK'
  process.stdout.write(JSON.stringify(mode === 'agy' ? {event:'result',result:{status:'SUCCESS',response:text}} : {text,stopReason:'end_turn'}))
}
