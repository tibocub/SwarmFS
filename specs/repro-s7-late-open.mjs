// S7 repro: a stream handed to one side's Swarmwire later than the other's never connects.
import { Swarmwire } from 'file:///E:/Code/P2P/swarmwire/index.js'
import { Duplex } from 'file:///E:/Code/P2P/swarmwire/node_modules/streamx/index.js'
import Protomux from 'file:///E:/Code/P2P/swarmwire/node_modules/protomux/index.js'

function streams () {
  let a = null
  let b = null
  a = new Duplex({ write (d, cb) { b.push(d); cb() } })
  b = new Duplex({ write (d, cb) { a.push(d); cb() } })
  return [a, b]
}
function net () {
  const n = { join: () => ({ destroy () {} }), on (e, fn) { if (e === 'connection') n.emit = fn } }
  return n
}

async function run (delay) {
  const A = net()
  const B = net()
  const wa = new Swarmwire({ swarm: A })
  const wb = new Swarmwire({ swarm: B })
  let connected = 0
  wa.on('peer-connected', () => connected++)
  wb.on('peer-connected', () => connected++)
  const [sa, sb] = streams()
  Protomux.from(sa); Protomux.from(sb) // the app already muxes the stream (hypergraph does)
  A.emit(sa, { publicKey: Buffer.alloc(32, 2) })
  await new Promise((resolve) => setTimeout(resolve, delay))
  B.emit(sb, { publicKey: Buffer.alloc(32, 1) })
  await new Promise((resolve) => setTimeout(resolve, 300))
  console.log(`B handed the stream ${delay} ms after A: peer-connected ${connected} of 2`)
  sa.destroy(); sb.destroy()
  await wa.destroy(); await wb.destroy()
}
await run(0)
await run(100)
