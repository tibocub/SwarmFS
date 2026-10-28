# Quickstart: SwarmFS v1

```js
import { SwarmFS } from 'swarmfs'

// On the PC
const pc = await SwarmFS.open('./pc', { password: 'pc secret', deviceName: 'pc' })
const files = await pc.createSpace('My files')
await files.add('/home/tibo/photos')
const { code } = await pc.addDevice({ password: 'pc secret' })   // show it as text or QR

// On the phone
const phone = await SwarmFS.open('./phone', { joinCode: code, deviceName: 'phone' })
const drive = phone.space(phone.spaces()[0].key)
const { items } = await drive.list()                 // photos/, with holders: [{ name: 'pc', online }]
const photos = items[0]
const { items: inside } = await drive.list(photos.id)
await drive.fetch(inside[0].id, '/sdcard/a.jpg')     // from the PC, verified; then held by the phone too
```

CLI, two machines (`npx swarmfs …` from this folder, or `node bin/swarmfs.js`; `bare bin/swarmfs.js`
works too). Public DHT; data in `~/.swarmfs` (`--dir` for another), device named after the host
(`--name` on its first command).

```bash
# PC
swarmfs create "My files"
swarmfs add "My files" ~/photos
swarmfs pair                      # prints a code; ends once the phone joined
swarmfs serve                     # stays online for the phone; Ctrl+C to stop

# phone (second machine), while the PC serves
swarmfs join <code>
swarmfs ls "My files"             # id, kind, name, size, holders: "<pc> (online)"
swarmfs ls "My files" <folder id>
swarmfs get "My files" <file id> ./a.jpg
```

The smallest set: one-shot commands open, act, close; only `pair` (until the join) and `serve` stay
online. `ls`/`get` wait up to 15 s for one of the person's other devices to connect, so holders show
online. After `join`, the first `ls` waits those 15 s for the space's name (hypergraph H12); the
space key works at once. `rescan` and `devices` as in contracts/api.md.
