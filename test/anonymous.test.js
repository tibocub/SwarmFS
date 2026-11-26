// An anonymous (I2P-only) instance, over hypergraph's SAM stand-in: photos it adds or uploads lose their metadata
// (camera, time, place) before they are hashed, the person's own file untouched; photos stay out of its linked
// folders; a regular instance keeps them as they are; and nothing of another identity's files on the same
// computer is found or served by it. Plus lib/strip.js on JPEG, PNG and WebP.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { strip } from '../lib/strip.js'
import { device, person, tmpDir, writeTree } from './helpers.js'
import { localPath } from '../lib/holdings.js'

import sam from 'hypergraph/test/next/net/_sam.js'
import dht from 'hypergraph/lib/i2p/dht.js'

const { standIn } = sam
const { I2PDHT } = dht

const b = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))))
const seg = (marker, body) => b([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255], body)
const JFIF = seg(0xe0, 'JFIF\0\x01\x01\0\0\x01\0\x01\0\0')
const EXIF = seg(0xe1, 'Exif\0\0GPSLatitude 48.85 GPSLongitude 2.35 Canon')
const SCAN = b([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0], 'pixels', [0xff, 0xd9])
const photo = () => b([0xff, 0xd8], JFIF, EXIF, seg(0xfe, 'a comment'), SCAN)

function pngChunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  return b(len, type, data, [0, 0, 0, 0]) // CRC: unchecked here
}
function webpChunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32LE(data.length)
  return b(type, len, data, data.length & 1 ? [0] : [])
}

test('strip: JPEG loses EXIF and comments, keeps JFIF and the scan', (t) => {
  const out = Buffer.from(strip(photo()))
  t.absent(out.includes('GPSLatitude'), 'no position')
  t.absent(out.includes('a comment'))
  t.ok(out.includes('JFIF'))
  t.ok(out.subarray(out.length - SCAN.length).equals(SCAN), 'the image data as it was')
  t.is(strip(b([0xff, 0xd8], JFIF, SCAN)), null, 'nothing to strip: null')
})

test('strip: PNG loses eXIf and text chunks, keeps the image chunks', (t) => {
  const sig = b([0x89], 'PNG\r\n\x1a\n')
  const ihdr = pngChunk('IHDR', Buffer.alloc(13, 1))
  const idat = pngChunk('IDAT', Buffer.from('pixels'))
  const iend = pngChunk('IEND', Buffer.alloc(0))
  const out = Buffer.from(strip(b(sig, ihdr, pngChunk('tEXt', 'Author\0Ana'), pngChunk('eXIf', 'GPS'), idat, iend)))
  t.ok(out.equals(b(sig, ihdr, idat, iend)))
})

test('strip: WebP loses EXIF and XMP, its flags cleared and its size right', (t) => {
  const vp8x = webpChunk('VP8X', Buffer.from([0x0c, 0, 0, 0, 1, 0, 0, 1, 0, 0]))
  const body = b('WEBP', vp8x, webpChunk('VP8L', Buffer.from('pixels!')), webpChunk('EXIF', 'GPS'), webpChunk('XMP ', '<x/>'))
  const len = Buffer.alloc(4)
  len.writeUInt32LE(body.length)
  const out = Buffer.from(strip(b('RIFF', len, body)))
  t.absent(out.includes('GPS'))
  t.absent(out.includes('<x/>'))
  t.is(out.readUInt32LE(4), out.length - 8, 'RIFF size')
  t.is(out[20] & 0x0c, 0, 'no EXIF or XMP flag')
  t.is(strip(Buffer.from('just text')), null, 'not an image: null')
})

async function i2p (t) {
  const router = await standIn()
  const boot = await I2PDHT.open({ sam: { port: router.port }, ephemeral: false, firewalled: false })
  await boot.ready()
  t.teardown(async () => { await boot.destroy(); await router.close() }, { order: 10 })
  return { port: router.port, bootstrap: [boot.bootstrapAddress] }
}

test('anonymous: a photo added or uploaded is served without its metadata, the original untouched; photos stay out of linked folders', { timeout: 90000 }, async (t) => {
  const ana = await person(t, 'ana', { transport: 'i2p', sam: await i2p(t) })
  const disk = writeTree(tmpDir(t, 'ana-disk'), { 'trip.jpg': 'x', 'notes.txt': 'notes', 'album/beach.jpg': 'x', 'album/list.txt': 'a list' })
  fs.writeFileSync(path.join(disk, 'trip.jpg'), photo())
  fs.writeFileSync(path.join(disk, 'album/beach.jpg'), photo())
  const drive = await ana.createSpace('Mine')
  const e = await drive.add(path.join(disk, 'trip.jpg'))
  const served = await localPath(ana.hg, e.hash)
  t.ok(served.startsWith(path.join(ana.dir, 'stripped')), 'served from a copy in the instance folder')
  t.absent(fs.readFileSync(served).includes('GPSLatitude'), 'the served copy has no position')
  t.ok(fs.readFileSync(path.join(disk, 'trip.jpg')).includes('GPSLatitude'), 'the person\'s own file is untouched')
  const notes = await drive.add(path.join(disk, 'notes.txt'))
  t.is(await localPath(ana.hg, notes.hash), path.join(disk, 'notes.txt'), 'not a photo: served in place')

  await drive.add(path.join(disk, 'album'))
  const names = (await drive.list(drive.top)).items.map((x) => x.name)
  const album = (await drive.list(drive.top)).items.find((x) => x.name === 'album')
  t.ok(names.includes('album'))
  t.alike((await drive.list(album.id)).items.map((x) => x.name), ['list.txt'], 'the photo stayed out of the linked folder')

  const site = await ana.createSite('Pics')
  const up = await site.upload(path.join(disk, 'trip.jpg'))
  t.absent(fs.readFileSync(await localPath(ana.hg, up.hash)).includes('GPSLatitude'), 'an upload too')
})

test('regular: a photo keeps its metadata; another identity on this computer never finds it', { timeout: 90000 }, async (t) => {
  const dan = await person(t, 'dan')
  const ana = await device(t, 'ana', { transport: 'i2p', sam: await i2p(t), minFree: 0 })
  const disk = writeTree(tmpDir(t, 'dan-disk'), { 'p.jpg': 'x' })
  fs.writeFileSync(path.join(disk, 'p.jpg'), photo())
  const e = await (await dan.createSpace('Dan')).add(path.join(disk, 'p.jpg'))
  t.is(await localPath(dan.hg, e.hash), path.join(disk, 'p.jpg'), 'served in place, metadata and all')
  t.is(await localPath(ana.hg, e.hash), null, 'the anonymous identity doesn\'t see dan\'s copy, same content or not')
})
