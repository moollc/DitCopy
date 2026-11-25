# DitCopy

DIT copy tool for macOS, Linux and Windows: recursive multi destination copy with hash verify, filters, cascade, MHL seals, and HTML and text reports.

## Download

Nothing else needs to be installed. Node and the copy engine are inside.

| System | Download | Then |
|---|---|---|
| Mac (Apple Silicon) | [DitCopy-0.1.0-macos-arm64.dmg](https://github.com/moollc/DitCopy/releases/download/v0.1.0/DitCopy-0.1.0-macos-arm64.dmg) | Open it, drag DitCopy to Applications, open DitCopy. The first time, right click it and choose Open, then Open again. |
| Windows | [DitCopy-0.1.0-windows-x64-setup.exe](https://github.com/moollc/DitCopy/releases/download/v0.1.0/DitCopy-0.1.0-windows-x64-setup.exe) | Run it. It installs for you without an administrator prompt. If Windows SmartScreen appears, choose More info, then Run anyway. Start DitCopy from the Start menu. |
| Linux (Ubuntu 22.04 or newer, Debian, Mint) | [DitCopy-0.1.0-linux-x64.deb](https://github.com/moollc/DitCopy/releases/download/v0.1.0/DitCopy-0.1.0-linux-x64.deb) | Open it with your software installer, or run `sudo dpkg -i DitCopy-0.1.0-linux-x64.deb`. Start DitCopy from the applications menu, or run `ditcopy`. |

All files and the portable archives (unpack and run `start.command`, `start.sh` or `start.bat`) are on the [releases page](https://github.com/moollc/DitCopy/releases/latest). The apps are not signed yet, which is why macOS and Windows ask once. Intel Macs and ARM computers are not built yet.

DitCopy opens as a page in your browser at http://127.0.0.1:34826. On a Mac it also has its own window. Your logs and saved jobs are kept in your user data folder, never inside the program folder.

## Run from source (developers)

This is only for people changing DitCopy. It needs Node.js 20 or newer (https://nodejs.org) and Rust (https://rustup.rs), and it builds the copy engine on first start.

| System | Start | Stop |
|---|---|---|
| macOS | double click `start.command` | double click `stop.command` |
| Linux | `./start.sh` | `./stop.sh` |
| Windows | double click `start.bat` | double click `stop.bat` |
| Any | `node ditcopy.js start` | `node ditcopy.js stop` |

The page opens at http://127.0.0.1:34826 (34826 spells DITCO on a phone keypad). `node ditcopy.js status` says whether it is running. `DITCOPY_PORT` changes the port, `OPEN_BROWSER=0` keeps the page from opening.

Manual server:

```bash
node server/server.js
```

## What works on which system

| Feature | macOS | Linux | Windows |
|---|---|---|---|
| Copy, verify, MHL, reports, resume | yes | yes | yes |
| Drive list and drive identity | diskutil | df and findmnt | PowerShell volumes |
| Keep awake during a copy | caffeinate | systemd-inhibit | execution state call |
| Uncached drive speed test | yes | yes | no |
| Eject and unmount from the page | yes | use the file manager | use the file manager |
| USB 2 link warning | yes | no | no |
| Native window app | yes | browser only | browser only |

macOS is run by hand. Linux and Windows are checked by the automated tests on all three systems (`.github/workflows/ci.yml`), which use sample drive output. They have not yet been run by hand on real Linux or Windows machines, so report anything odd with drive names or identities there.


## API

`POST /api/jobs` accepts the full contract body (`perfectVerify`, `hash`, include/exclude, sizes, dates, `speed`, `diskMode`, `confirm`, `cascade`, `writeMhl`, `writeReport`, `keepAwake`, `resumeFrom`, `jobName`).

Destructive modes (`sync`, `move`, `delete`) require `confirm: true` or the API returns 400.

**Cascade:** when `cascade` is true and there are 2+ destinations, the server runs pass 1 as `src → dest[0]`, then on success pass 2 as **the same `src` → `dest[1..]`** (it does not re-source from `dest[0]`).

Other endpoints:

| Method | Path | Role |
|--------|------|------|
| GET | `/api/health` | Engine path + probed CLI flags |
| GET | `/api/volumes` | `/Volumes` + free bytes |
| GET/POST | `/api/saved-jobs` | List / save named jobs under `jobs/` |
| POST | `/api/saved-jobs/:name/run` | Start from saved job |
| GET | `/api/presets` | List `presets/*.json` |
| GET | `/api/history` | Finished jobs this process |
| GET | `/api/jobs/:id/report` | Report + MHL paths |
| GET | `/reports/:file` | Static HTML/TXT reports |

Artifacts per job:

- `logs/<id>.jsonl` : events
- `logs/<id>.checkpoint.json` : completed files (resume via `resumeFrom`)
- `logs/reports/<id>.html` + `.txt`
- `<each-dest>/<id>.mhl` and `<each-dest>/DitCopy.mhl` when `writeMhl`

## Engine CLI

Binary: `engine/target/release/ditcopy_engine`

Contract flags (the server probes `--help` and only passes flags the binary advertises):

```bash
./engine/target/release/ditcopy_engine copy \
  --src PATH --dest PATH \
  --mode force|noexist|diff|newer|sync|move|delete|verify-only \
  --verify true|false \
  --perfect-verify \
  --hash xxh3|xxh64|md5|sha256 \
  --include "a*;*.mov" --exclude "*.tmp" \
  --min-size N --max-size N \
  --from-date YYYYMMDD --to-date YYYYMMDD \
  --speed full|autoslow|90|50|10 \
  --disk-mode auto|same|diff \
  --nonstop --confirm \
  --job-id ID \
  --checkpoint PATH \
  --resume-checkpoint PATH
```

Smoke fixtures:

```bash
./engine/target/release/ditcopy_engine copy \
  --src ./fixtures/src \
  --dest /tmp/ditcopy-a \
  --dest /tmp/ditcopy-b \
  --mode force \
  --verify true \
  --nonstop \
  --job-id smoke1
```

Stdout is JSONL events: `start`, `progress`, `file`, `done`, `error`.

## Presets

| File | Intent |
|------|--------|
| `presets/camera-dual.json` | Force + verify + MHL + report, two empty dest slots |
| `presets/camera-triple.json` | Same with three dests |
| `presets/verify-only.json` | `mode: verify-only` |

## MCP (grok / Cursor)

```bash
cd mcp && npm install
```

Tools prefer `http://127.0.0.1:34826` when healthy. Tools: `start_job` (full fields), `save_job`, `list_saved_jobs`, `run_saved_job`, `list_presets`, `apply_preset`, `generate_report`, `seal_mhl`, `get_last_report`, `estimate_job`.

## Layout

| Path | Role |
|------|------|
| `engine/` | Rust copy/hash engine |
| `server/` | Node HTTP API + static UI (stdlib only) |
| `ui/` | Browser UI |
| `mcp/` | MCP stdio bridge |
| `presets/` | Built-in job presets |
| `jobs/` | Saved named jobs |
| `fixtures/src/` | Smoke-test source tree |
| `logs/` | Job JSONL, checkpoints, `reports/`, `server.pid` |

### Destination write buffering

Different disk copies use queues that grow as needed, defaulting to about 1 GiB
per destination. The engine flags `--writer-buffer-mib` and
`--writer-total-buffer-mib` set the budgets; the total defaults to and cannot
exceed 2048 MiB per engine job, including in flight chunks and reader buffers.
The budget is shared across destinations and does not reserve memory in advance.
Concurrent jobs each have their own cap. A brief destination stall can be absorbed
while faster destinations run ahead. Once the bounded backlog fills, a destination
that stays slow still sets the pace. This is not unlimited speed independence.

Same disk mode streams the source separately for each destination, completing one
writer before opening the next. It uses bounded memory without interleaving
writes across destination files on the same spinning disk.

Cooldown remains off by default. Each destination establishes its own baseline
from 64 MiB of actual write timings after its queue first fills. Recent write
speed is compared at the configured byte interval; the baseline carries across
files. Reader speed and pause time are excluded. Only the destination whose
measured writes slow down takes a cooldown pause. This is not a temperature
measurement.

Files are written to unique hidden sibling `.partial` names. Successful flush
and requested verification finish before an atomic rename publishes the final
name. An interrupted or failed overwrite leaves any earlier complete file intact;
its partial temporary file is never accepted by noexist, diff, or resume as the
planned final file. Resume still validates source and all destination hashes.
At the next copy, matching DitCopy partials for files about to be written are
removed only when their recorded process no longer exists; reports list removed
paths. If cleanup fails, copying continues with a warning and the report lists
what was not removed. Live process files, symlinks, unrelated names and malformed
names are kept. A partial left by another Mac on a shared network folder can
look stale here.
Verification mismatches retain the visible NAME.ditcopy_verify_err file.

Files smaller than one 8 MiB chunk use a bounded direct write path without
creating per-file threads and queues. Hashing, verification, failure isolation,
temporary names and atomic publication are the same as for larger files.

Each running copy job can hold about 1 GiB of memory with the default queues;
concurrent jobs add their memory use. The 2 GiB configured buffer cap is per job,
not a shared server limit.

## Native app

`app/build-app.sh` builds `app/DitCopy.app` for developers. The downloadable Mac app is made by the release workflow with `app/build-app.sh --bundle`, and carries its own Node and engine. Either one is a window around this same UI with a Dock icon and a notification when a copy finishes or needs attention. It starts the server for you. Quitting while a copy runs asks first, because the server and engine keep running without the window; use `stop.command` to stop them. Clicking a finished notification brings the window forward. The browser at http://127.0.0.1:34826 still works.

The server only answers requests addressed to 127.0.0.1 or localhost, and refuses writes that come from another web origin.

The app is signed ad hoc, so on another Mac the first launch needs right click, Open. `app/make-icon.py` redraws the icon.

## License

MIT. See `LICENSE`.
