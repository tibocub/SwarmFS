// Photo metadata (camera, time, place) out of JPEG, PNG and WebP, for uploads by an I2P-only (anonymous) instance:
// a photo's GPS position would undo what I2P hides. Only metadata goes; the pixels and what draws them stay
// (JPEG: JFIF, the ICC colour profile, Adobe's colour transform; PNG and WebP: every image chunk).

const JPEG_KEEP = new Set([0xe0, 0xee]) // APP0 (JFIF), APP14 (Adobe); APP2 only for an ICC profile (below)
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME'])
const WEBP_DROP = new Set(['EXIF', 'XMP '])

/**
 * The same image without its metadata, or null when it had none (or isn't a JPEG, PNG or WebP).
 * @param {Uint8Array} buf
 * @returns {Uint8Array | null}
 */
export function strip (buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpeg(buf)
  if (ascii(buf, 1, 3) === 'PNG' && buf[0] === 0x89) return png(buf)
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WEBP') return webp(buf)
  return null
}

/** @param {Uint8Array} buf */
function jpeg (buf) {
  const parts = [buf.subarray(0, 2)]
  let i = 2
  let dropped = false
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1]
    if (marker === 0xda) break // start of scan: the image data, kept as it is
    const len = (buf[i + 2] << 8) | buf[i + 3]
    const seg = buf.subarray(i, i + 2 + len)
    const app = marker >= 0xe0 && marker <= 0xef
    const icc = marker === 0xe2 && ascii(buf, i + 4, 11) === 'ICC_PROFILE'
    if ((app && !JPEG_KEEP.has(marker) && !icc) || marker === 0xfe) dropped = true // APPn metadata, COM
    else parts.push(seg)
    i += 2 + len
  }
  if (!dropped) return null
  parts.push(buf.subarray(i))
  return concat(parts)
}

/** @param {Uint8Array} buf */
function png (buf) {
  const parts = [buf.subarray(0, 8)]
  let i = 8
  let dropped = false
  while (i + 12 <= buf.length) {
    const len = u32be(buf, i)
    const type = ascii(buf, i + 4, 4)
    const chunk = buf.subarray(i, i + 12 + len)
    if (PNG_DROP.has(type)) dropped = true
    else parts.push(chunk)
    i += 12 + len
    if (type === 'IEND') break
  }
  return dropped ? concat(parts) : null
}

/** @param {Uint8Array} buf */
function webp (buf) {
  const parts = []
  let i = 12
  let dropped = false
  while (i + 8 <= buf.length) {
    const type = ascii(buf, i, 4)
    const len = u32le(buf, i + 4)
    const chunk = buf.subarray(i, i + 8 + len + (len & 1)) // chunks are padded to even sizes
    if (WEBP_DROP.has(type)) dropped = true
    else parts.push(type === 'VP8X' ? vp8x(chunk) : chunk)
    i += 8 + len + (len & 1)
  }
  if (!dropped) return null
  const body = concat(parts)
  const head = new Uint8Array(12)
  head.set(buf.subarray(0, 12))
  new DataView(head.buffer).setUint32(4, body.length + 4, true) // RIFF size: 'WEBP' and the chunks
  return concat([head, body])
}

// VP8X says which chunks follow: its EXIF (bit 3) and XMP (bit 2) flags go with them.
/** @param {Uint8Array} chunk */
function vp8x (chunk) {
  const out = new Uint8Array(chunk)
  out[8] &= ~0x0c
  return out
}

/** @param {Uint8Array} buf @param {number} at @param {number} n */
const ascii = (buf, at, n) => String.fromCharCode(...buf.subarray(at, at + n))
/** @param {Uint8Array} buf @param {number} at */
const u32be = (buf, at) => ((buf[at] << 24) >>> 0) + (buf[at + 1] << 16) + (buf[at + 2] << 8) + buf[at + 3]
/** @param {Uint8Array} buf @param {number} at */
const u32le = (buf, at) => buf[at] + (buf[at + 1] << 8) + (buf[at + 2] << 16) + ((buf[at + 3] << 24) >>> 0)

/** @param {Uint8Array[]} parts */
function concat (parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
