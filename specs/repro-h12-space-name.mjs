// H12 repro: on a new device, 'spaces' fires while a space's name is still '', and not again
// when the name arrives. Run: node specs/repro-h12-space-name.mjs
import fs from 'fs'
import os from 'os'
import path from 'path'
import hypergraph from 'hypergraph/next'
import createTestnet from 'hyperdht/testnet.js'
import { types, rules } from '../lib/types.js'

const { Hypergraph } = hypergraph
const testnet = await createTestnet(3)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h12-'))
const open = (name, opts) => Hypergraph.open(path.join(tmp, name), { types, rules, bootstrap: testnet.bootstrap, ...opts })

const pc = await open('pc')
await pc.connectToSwarm()
await pc.createSpace({ name: 'My files', private: true })
const { code, added } = await pc.addDevice()
const phone = await open('phone', { joinCode: code })
await added

const t0 = Date.now()
phone.on('spaces', () => console.log(`${Date.now() - t0} ms 'spaces':`, JSON.stringify(phone.spaces())))
await phone.connectToSwarm()
await new Promise((resolve) => setTimeout(resolve, 3000))
console.log(`${Date.now() - t0} ms no event, but now:`, JSON.stringify(phone.spaces()))

await phone.close()
await pc.close()
await testnet.destroy()
fs.rmSync(tmp, { recursive: true, force: true })
