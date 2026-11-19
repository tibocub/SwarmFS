# CLI

`bin/swarmfs.js` is a thin tool over the library, for trying SwarmFS and for tests; it has no logic
of its own. Run it with `npx swarmfs`, `node bin/swarmfs.js` or `bare bin/swarmfs.js`.

```text
swarmfs [command] [--dir <folder>] [--name <device name>] [--bootstrap <host:port>]
```

- `--dir`: the instance folder, default `~/.swarmfs`.
- `--name`: this device's name when made, default the host name.
- `--bootstrap`: a private DHT (tests).

## The shell

`swarmfs` alone (or `swarmfs shell`) opens the instance, stays online, runs `sync()` and reads
commands from stdin, one per line, until `quit`, the end of input or Ctrl+C. `help` lists them.
In a terminal the prompt is `> `; piped (scripts, tests), a `>` line follows each command's output,
since on Bare `process.stdout.write` never reaches a piped stdout. Words with spaces are quoted.

While it runs it prints one line per `sync` event and per person joining or leaving:

```text
fetched   <path>
conflict  <path> -> <copy path>
paused    <folder> (not found: unplugged?)
paused    <folder>: 600 files deleted at once; "confirm <folder>" removes them everywhere, or restore them
low-space <folder>: 3.2 GB free, floor 5.0 GB; fetching stopped
skipped   <path> (name not valid on this disk)
joined    <space>: Bob
```

## One-shot commands

`swarmfs <command> ...` opens, runs one command and closes, without syncing. `ls` and `get` wait up
to 15 s for another device of the person to connect. While a shell holds the folder, they fail with
`IN_USE`; on a folder with no device yet, with `NO_DEVICE`. `init` and `join` are one-shot only.

## Commands

| Command | Does |
|---|---|
| `init` | make this device; asks for a password |
| `join <code>` | make this folder a new device of that person; asks for a password |
| `pair` | print a code for a new device; asks for the password (once per shell); one-shot: ends once it joined |
| `devices` | this person's devices |
| `name <name>` | your name, shown to the people you share spaces with |
| `create <name> [--invites everyone\|chosen\|admins]` | a files space |
| `add <space> <path>` | a file or folder, in place |
| `ls <space> [folder]` | entries: id, kind, name, size, holders (tab-separated) |
| `get <space> <file> <path>` | fetch a file to `<path>` |
| `rescan` | follow the disk |
| `link <space> <folder> <path>` | sync a space folder (the space's name for its top) with a local folder |
| `unlink <path>` | stop syncing it; files and entries stay |
| `links` | linked folders here, paused or not |
| `confirm <path>` | apply a mass delete the folder was paused for |
| `trash` / `trash empty` | what syncing replaced or removed / delete it for good (asks; only `yes` empties) |
| `invite <space> [--uses N] [--days N]` | an invite code (one use by default) |
| `accept <code>` | join a space |
| `invites <space> [everyone\|chosen\|admins]` | show or change who may invite |
| `revoke <space> <code>` | no one else gets in with it |
| `members <space>` | name, role, online, key |
| `role <space> <member> admin\|trusted\|editor` | change a role |
| `remove <space> <member> [--ban] [--drop-all]` | take someone out (`--drop-all`: and what they added) |
| `leave <space>` | leave it on this device (files stay) |
| `bin <space>` / `bin empty <space>` | what was deleted there / delete for good what you may (asks) |
| `restore <space> <id>` | put an entry back from the bin |
| `show-holdings <space> on\|off` | let the others see what your devices hold there |
| `quit` | end the shell |

`<space>`: a name or a key. `<folder>`, `<file>`: a path of names from the top (`Photos/2024`) or an
id from `ls`. `<member>`: a name or the start of a key.

## Environment

- `SWARMFS_PASSWORD`: the password, instead of asking (scripts, tests). Typed in a terminal, it is
  hidden, and asked twice when new.
- `SWARMFS_MIN_FREE`: the free-space floor in bytes, instead of max(5 GB, 5 % of the disk).
