// Bytes through swarmwire, over the spaces' member streams only: nothing is announced or looked
// up on the DHT for a file, so who holds what stays inside each space.

import Protomux from 'protomux'
import { Swarmwire } from 'swarmwire-lib'
import b4a from 'b4a'
import { localPath, spaceOf } from './holdings.js'

/**
 * @typedef {import('swarmwire-lib').Swarm} Swarm
 * @typedef {import('swarmwire-lib').PeerIdentity} PeerIdentity
 * @typedef {import('stream').Duplex & { remotePublicKey: Uint8Array }} MemberStream hypergraph's member connections: Hyperswarm's streams
 */

/**
 * @param {import('./types.js').Hypergraph} hg
 * @param {Map<string, Set<string>>} fetching root -> keys of the spaces it is being downloaded for here
 * @returns {Swarmwire}
 */
export function transfer (hg, fetching) {
  /** @type {Parameters<Swarm['on']>[1] | null} */
  let onconnection = null
  /** @type {Swarm} */
  const net = {
    join: () => ({ destroy: async () => {} }), // peers meet in the spaces
    on (event, fn) { if (event === 'connection') onconnection = fn }
  }
  // A peer is served only files of the spaces its device is a member of.
  /** @param {PeerIdentity} peer */
  const member = (peer) => (/** @type {string} */ key) => !!peer.publicKey && !!spaceOf(hg, key)?.memberConnections()
    .some((m) => b4a.equals(/** @type {MemberStream} */ (m.stream).remotePublicKey, /** @type {Uint8Array} */ (peer.publicKey)))
  const wire = new Swarmwire({
    swarm: net,
    resolve: (root, peer) => localPath(hg, root, member(peer)),
    allowed: (root, peer) => [...(fetching.get(root) || [])].some(member(peer)),
    temporary: true
  })

  const handed = new WeakSet() // the same stream comes from every space two devices share
  const attached = new WeakSet()
  const spaces = () => hg.spaces().map(({ key }) => hg.space(key))

  /** @param {MemberStream} stream */
  const give = (stream) => {
    if (handed.has(stream)) return
    handed.add(stream)
    const connect = /** @type {NonNullable<typeof onconnection>} */ (onconnection) // set in Swarmwire's constructor
    connect(stream, { publicKey: stream.remotePublicKey }) // swarmwire's peer id
  }
  // A peer no longer a member of any files space here: stop serving it (the stream stays, hypergraph's).
  // shortcut: closes swarmwire's channel by its protocol name; use swarmwire's own call once it has one.
  /** @param {MemberStream} stream */
  const leave = (stream) => {
    if (spaces().some((s) => s.memberConnections().some((m) => m.stream === stream))) return
    handed.delete(stream)
    // protomux iterates its channels; the declarations hypergraph and swarmwire ship leave that out
    const channels = /** @type {Iterable<import('protomux').Channel & { protocol: string }>} */ (/** @type {unknown} */ (Protomux.from(stream)))
    for (const channel of channels) if (channel.protocol === 'swarmwire/0') channel.close()
  }
  const attach = () => {
    for (const space of spaces()) {
      if (attached.has(space)) continue
      attached.add(space)
      space.on('member-connection', give)
      space.on('member-disconnection', leave)
      for (const m of space.memberConnections()) give(/** @type {MemberStream} */ (m.stream))
    }
  }
  attach()
  hg.on('spaces', attach)
  return wire
}
