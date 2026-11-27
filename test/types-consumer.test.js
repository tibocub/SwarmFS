// The published .d.ts (npm run types) work in a strict TypeScript project that installed no @types of its
// own ("types": []), reached through package exports as a user would (HyperBrowser's deep imports too): no
// error on right use, an error on a typo (so the types really load, not any).

import test from 'brittle'

if (typeof Bare !== 'undefined') {
  test('types consumer: skipped on Bare (a Node script)', (t) => t.pass('skipped on Bare'))
} else {
  const fs = await import('fs')
  const os = await import('os')
  const path = await import('path')
  const { spawnSync } = await import('child_process')
  const { fileURLToPath } = await import('url')

  const root = fileURLToPath(new URL('../', import.meta.url))
  const tsc = root + 'node_modules/typescript/bin/tsc'

  const GOOD = `import { SwarmFS, SwarmFSError, type Drive, type Entry, type Site, type SyncEvent } from 'swarmfs'
import { compile, ignored } from 'swarmfs/lib/ignore.js'
import { rootOf, BIN } from 'swarmfs/lib/types.js'
import { Hypergraph, type Space, type HgRecord, type Change } from 'hypergraph/next'
import { Swarmwire, type Swarm } from 'swarmwire-lib'

export async function main (dir: string): Promise<void> {
  const sfs = await SwarmFS.open(dir, { deviceName: 'pc', minFree: 0 })
  sfs.on('sync', (e: SyncEvent) => { const p: string | undefined = e.path; void p })
  sfs.on('members', ({ space, joined }) => { const n: string | null = joined[0]?.name ?? null; void space; void n })
  sfs.on('spaces', () => {})

  const drive: Drive = await sfs.createSpace('Photos', { invites: 'chosen' })
  const page = await drive.list(drive.top, { limit: 10 })
  const first: Entry | undefined = page.items[0]
  if (first?.hash) await drive.fetch(first.id, 'copy.jpg')
  for (const m of await drive.members()) { const who: string = m.identity; void who }

  const site: Site = await sfs.createSite('Blog', { types: { post: { fields: { title: 'string' } } } })
  const bytes: Uint8Array = await site.read('index.html')
  void bytes

  const skip: boolean = ignored(compile('*.log'), 'a.log', false)
  void skip
  void rootOf({ src: ['swarmwire://' + 'a'.repeat(64)], size: 1, type: '', digest: '', mutable: false })
  void BIN

  // hypergraph and swarmwire loaded next to it: their types don't clash (both type protomux).
  const hg = await Hypergraph.open(dir + '/hg')
  const space: Space = await hg.createSpace({ name: 'x' })
  const rec: HgRecord | undefined = (await space.query('post').latest(1)).items[0]
  const change: Change | null = null
  const wire = (swarm: Swarm) => new Swarmwire({ swarm })
  void rec, change, wire

  try { await sfs.close() } catch (err) { if (err instanceof SwarmFSError) { const code: string = err.code; void code } }
}
`
  const BAD = `import { SwarmFS, type Drive } from 'swarmfs'

export async function typo (sfs: SwarmFS, drive: Drive): Promise<void> {
  sfs.notAThing()
  await drive.setInvites('nobody')
}
`

  function node (args, cwd = root) {
    return spawnSync(process.execPath, args, { cwd, encoding: 'utf8' })
  }

  test('types consumer: no @types installed, strict, node16; right use passes, a typo fails', { timeout: 300000 }, async (t) => {
    const build = node([tsc, '-p', 'jsconfig.json', '--noEmit', 'false', '--declaration', '--emitDeclarationOnly', '--outDir', 'dist/types'])
    t.is(build.status, 0, 'npm run types: tsc ' + build.stdout.slice(0, 2000))
    const copy = node([root + 'scripts/types.js'])
    t.is(copy.status, 0, 'npm run types: scripts/types.js ' + copy.stderr)

    const dir = fs.mkdtempSync(path.join(process.env.HG_TEST_TMP || os.tmpdir(), 'sfs-types-'))
    // swarmfs, the hypergraph and swarmwire it uses, and one @types/node, as a user who installed all three has them:
    // the siblings' own copies can differ in version (CI), and two copies clash
    const links = [[root, 'swarmfs'], ...['hypergraph', 'swarmwire-lib', '@types/node', 'undici-types'].map((name) => [fs.realpathSync(root + 'node_modules/' + name), name])]
      .map(([target, name]) => ({ target, link: path.join(dir, 'node_modules', name) }))
    fs.mkdirSync(path.join(dir, 'node_modules', '@types'), { recursive: true })
    for (const { target, link } of links) fs.symlinkSync(target, link, 'junction')
    t.teardown(() => {
      // Only the links themselves go (rmdir on a junction leaves its target alone); the folder only once they're gone.
      for (const { link } of links) try { process.platform === 'win32' ? fs.rmdirSync(link) : fs.unlinkSync(link) } catch {}
      if (links.every(({ link }) => !fs.existsSync(link))) fs.rmSync(dir, { recursive: true, force: true })
    })

    fs.writeFileSync(path.join(dir, 'good.mts'), GOOD)
    fs.writeFileSync(path.join(dir, 'bad.mts'), BAD)
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, module: 'node16', moduleResolution: 'node16', target: 'ES2022', types: [], noEmit: true, preserveSymlinks: true },
      files: ['good.mts', 'bad.mts']
    }))

    const res = node([tsc, '-p', path.join(dir, 'tsconfig.json')], dir)
    const errors = res.stdout.split('\n').filter((line) => line.includes('error TS'))
    const elsewhere = errors.filter((line) => !line.startsWith('bad.mts'))
    t.alike(elsewhere, [], 'no error in good.mts or in the published types')
    t.ok(errors.some((line) => line.startsWith('bad.mts') && line.includes('notAThing')), 'sfs.notAThing is an error: ' + errors.join('\n'))
    t.ok(errors.some((line) => line.startsWith('bad.mts(5,') && line.includes('"nobody"')), 'an invite setting that is none is an error')
  })
}
