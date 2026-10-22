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

CLI, two machines:

```bash
swarmfs init && swarmfs create "My files" && swarmfs add "My files" ~/photos && swarmfs pair
swarmfs join <code> && swarmfs ls "My files" && swarmfs get "My files" <id> ./a.jpg
```
