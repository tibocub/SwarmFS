/**
 * After tsc wrote the declarations (npm run types): the entry point references Node's types
 * (@types/node, a dependency), which SwarmFS's use (streams, fs), so a project that installed none still loads them.
 */

import fs from 'fs'
import { fileURLToPath } from 'url'

const entry = fileURLToPath(new URL('../dist/types/index.d.ts', import.meta.url))
fs.writeFileSync(entry, '/// <reference types="node" />\n' + fs.readFileSync(entry, 'utf8'))
