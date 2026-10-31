// Bytes through swarmwire, over the files spaces' member streams only: nothing is
// announced or looked up on the DHT for a file (research R8, swarmwire contract 3.9).

import Protomux from 'protomux'
import { Swarmwire } from 'swarmwire-lib'
import b4a from 'b4a'
import { localPath, spaceOf } from './holdings.js'

// `fetching`: root → keys of the spaces it is being downloaded for here (Drive.fetch, sync).
export function transfer (hg, fetching) {
  let onconnection = null
  const net = {
    join: () => ({ destroy () {} }), // peers meet in the spaces
    on (event, fn) { if (event === 'connection') onconnection = fn }
  }
  // A peer is served only files of the spaces its device is a member of (spec 003 FR-008, swarmwire S10).
  const member = (peer) => (key) => !!peer.publicKey && !!spaceOf(hg, key)?.memberConnections()
    .some((m) => b4a.equals(m.stream.remotePublicKey, peer.publicKey))
  const wire = new Swarmwire({
    swarm: net,
    resolve: (root, peer) => localPath(hg, root, member(peer)),
    allowed: (root, peer) => [...(fetching.get(root) || [])].some(member(peer)),
    temporary: true
  })

  const handed = new WeakSet() // the same stream comes from every space two devices share
  const attached = new WeakSet()
  const spaces = () => hg.spaces().map(({ key }) => hg.space(key))

  const give = (stream) => {
    if (handed.has(stream)) return
    handed.add(stream)
    onconnection(stream, { publicKey: stream.remotePublicKey }) // swarmwire's peer id
  }
  // A peer no longer a member of any files space here: stop serving it (the stream stays, hypergraph's).
  // shortcut: closes swarmwire's channel by its protocol name; use swarmwire's own call once S8 lands.
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
