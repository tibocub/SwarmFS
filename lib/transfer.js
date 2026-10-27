// Bytes through swarmwire, over the files spaces' member streams only: nothing is
// announced or looked up on the DHT for a file (research R8, swarmwire contract 3.9).

import Protomux from 'protomux'
import { Swarmwire } from 'swarmwire-lib'
import { localPath } from './holdings.js'

export function transfer (hg) {
  let onconnection = null
  const net = {
    join: () => ({ destroy () {} }), // peers meet in the spaces
    on (event, fn) { if (event === 'connection') onconnection = fn }
  }
  const wire = new Swarmwire({ swarm: net, resolve: (root) => localPath(hg, root), temporary: true })

  const handed = new WeakSet() // the same stream comes from every space two devices share
  const attached = new WeakSet()
  const spaces = () => hg.spaces().map(({ key }) => hg.space(key))

  const give = (stream) => {
    if (handed.has(stream)) return
    handed.add(stream)
    onconnection(stream, { publicKey: stream.remotePublicKey }) // swarmwire's peer id
  }
  // A peer no longer a member of any files space here: stop serving it (the stream stays, hypergraph's).
  const leave = (stream) => {
    if (spaces().some((s) => s.memberConnections().some((m) => m.stream === stream))) return
    handed.delete(stream)
    for (const channel of Protomux.from(stream)) if (channel.protocol === 'swarmwire/0') channel.close()
  }
  const attach = () => {
    for (const space of spaces()) {
      if (attached.has(space)) continue
      attached.add(space)
      space.on('member-connection', give)
      space.on('member-disconnection', leave)
      for (const m of space.memberConnections()) give(m.stream)
    }
  }
  attach()
  hg.on('spaces', attach)
  return wire
}
