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
# PC: a shell, online (serving) until quit
swarmfs
> create "My files"
> add "My files" ~/photos
> pair                            # prints a code; the shell says "added <name>" once it joined

# phone (second machine)
swarmfs join <code>               # one-shot
swarmfs                           # a shell there too
> ls "My files"                   # id, kind, name, size, holders: "<pc> (online)"
> ls "My files" <folder id>
> get "My files" <file id> ./a.jpg
> quit
```

The shell is online all along: holders show online or offline as they are now. Right after `join`,
the space's name arrives a moment after it opens (hypergraph H12): `ls` answers `NOT_FOUND` until
then; ask again (the space key works at once). The shell's commands also run one-shot for scripts
(`swarmfs ls "My files"`: open, wait up to 15 s for another device, act, close), but not while a
shell holds the folder (`IN_USE`). `rescan` and `devices` as in contracts/api.md.
