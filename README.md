# FleetDeck

Single-container web app that manages a **diskless Windows gaming fleet** booting over iSCSI from **TrueNAS SCALE**. It replaces hand-editing iPXE scripts and clicking through the TrueNAS iSCSI UI:

- **Dashboard** — every client with live booted/offline status (iSCSI session poll), clone space delta, origin snapshot, last boot time.
- **One-click lifecycle** — create (clone golden → extent → target → LUN 0, all-or-nothing with rollback), reset, rebase, bulk reset, retire, nightly café-style wipes.
- **Golden image panel** — `@gold-vN` snapshots, which clients are on which version, one-button promote + bulk rebase.
- **iPXE boot script serving** — `GET /boot/<mac-hexhyp>.ipxe` renders each client's `sanboot` script straight from the database. Unknown MACs become "discovered clients" you adopt with one click.
- **Safety** — introspected API method names (survives TrueNAS renames), hard path guardrails, session-aware destructive ops, full audit log, `DRY_RUN` mode.

Stack: Node.js + Express + `ws` + SQLite (better-sqlite3). Frontend is one static HTML file, no build step. One Dockerfile.

---

## Environment assumptions

| Thing | Value (defaults; all editable in Settings) |
|---|---|
| TrueNAS SCALE | 25.10.x at `192.168.1.36`, WebSocket API at `wss://192.168.1.36:8444/websocket` (auto-falls-back to `wss://192.168.1.36/api/current` and the standard ports) |
| Pool / zvols | `Main_pool`, diskless zvols under `Main_pool/iscsi/` |
| Golden image | `Main_pool/iscsi/win-golden`, snapshots `@gold-vN` |
| iSCSI | base IQN `iqn.2005-10.org.freenas.ctl`; one target + device extent + LUN 0 per client; target name == zvol name |
| Boot chain | PXE → iPXE `snponly.efi` (embedded script) → HTTP `/boot/<mac>.ipxe` → `sanboot` |

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `TRUENAS_URL` | `wss://192.168.1.36:8444/websocket` | WebSocket endpoint or bare host; alternates are tried automatically |
| `TRUENAS_API_KEY` | *(empty)* | API key (TrueNAS UI → user icon → API Keys). Never logged, never stored in the DB. Without it the app runs disconnected (boot serving still works) |
| `ADMIN_PASSWORD` | *(empty = login disabled)* | single admin password for UI/API |
| `HTTP_PORT` / `BIND_ADDRESS` | `8080` / `0.0.0.0` | where UI **and** `/boot/*` listen — bind to a LAN interface; `/boot/*` is unauthenticated by design (firmware can't auth) |
| `DRY_RUN` | `0` | `1` = every TrueNAS **mutation** is logged to the events table instead of executed; reads still work |
| `DB_PATH` | `./data/fleetdeck.sqlite` | SQLite file (mount a volume) |
| `TRUENAS_VERIFY_TLS` | `0` | `0` accepts the box's self-signed cert |
| `POLL_INTERVAL_MS` | `10000` | iSCSI session poll cadence |

## Version-drift adapter

TrueNAS renames API methods across releases (`zfs.snapshot.*` → `pool.snapshot.*`, …). FleetDeck never trusts memorized names: on every (re)connect it calls `core.get_methods` and resolves each logical operation against candidate lists in **`lib/adapter.js`**. If a future release renames something, the dashboard shows exactly which operation is unresolved and the fix is one line in that one file. Payload shapes are centralized there too.

## Bring-up checklist (do this in order)

1. **Dry run first.** Deploy with `DRY_RUN=1`. Log in, confirm the header shows **connected**, the golden panel lists your real `@gold-*` snapshots, and existing zvols/targets appear. `GET /api/truenas-info` returns the box's version. Watch the events log while you click around — mutations show up as `dry_run` events, nothing touches the box.
2. **Throwaway client end-to-end.** Set `DRY_RUN=0`, create `clienttest` with a spare MAC. Verify in the TrueNAS UI: zvol `Main_pool/iscsi/clienttest`, extent `clienttest`, target `clienttest` with LUN 0. Fetch `http://<app>:8080/boot/<that-mac-hexhyp>.ipxe` and check the `sanboot` line. Reset it, then retire it (typed-name confirm) and verify all four objects are gone.
3. **Migrate boot serving** (below), then adopt your real machines one at a time: PXE-boot each once → it appears under *Discovered clients* → **adopt**.

## Migrating /boot/ from nginx (the one manual step)

Your embedded iPXE script currently chains to nginx on `192.168.1.246`. Point it at FleetDeck instead and rebuild `snponly.efi`:

`embed.ipxe`:

```ipxe
#!ipxe
dhcp
chain http://192.168.1.36:8080/boot/${mac:hexhyp}.ipxe || shell
```

(Use the IP/port where this app runs — e.g. the TrueNAS box IP and the Custom App's node port.)

```sh
git clone https://github.com/ipxe/ipxe.git
cd ipxe/src
make bin-x86_64-efi/snponly.efi EMBED=embed.ipxe
```

Copy the resulting `bin-x86_64-efi/snponly.efi` to wherever your TFTP server already serves it from. TFTP itself stays where it is — FleetDeck does not do TFTP in v1. Keep nginx running until FleetDeck has served a boot for every MAC (the *Last boot* column tells you), then decommission the nginx `/boot/` job.

## iPXE templates

Global template (Settings) and per-client raw overrides (client → edit). Variables: `{{name}} {{mac}} {{mac_hexhyp}} {{portal_ip}} {{iqn_prefix}} {{target_name}} {{zvol}} {{golden_snapshot}}`. Default:

```ipxe
#!ipxe
echo FleetDeck: booting {{name}} ({{mac}})
sanboot iscsi:{{portal_ip}}::::{{iqn_prefix}}:{{target_name}}
```

For golden-image maintenance, flip **"boot golden image on next serve"** on the client row — it serves the `win-golden` target exactly once, then auto-reverts.

## Safety model

- Destroy/re-clone only ever touches zvols that are **direct children of `managed_prefix`** (`Main_pool/iscsi/` by default) and **never** the golden zvol — hard blocks, not confirmations.
- No code path deletes snapshots; the adapter doesn't even expose a snapshot-delete method. Promote only creates.
- Reset/rebase/retire are **refused while the target has an active iSCSI session** unless you tick *force*.
- Retire requires typing the client name, and deletes targetextent → target → extent → zvol → DB row, in that order.
- Every mutation (and every boot-script serve) lands in the `events` audit table with before/after detail.

## Deploying on TrueNAS SCALE (Custom App)

Build & push the image somewhere the box can pull from (or build on the box):

```sh
docker build -t fleetdeck:latest .
```

Apps → **Custom App**:

| Field | Value |
|---|---|
| Image | `fleetdeck:latest` (or your registry path) |
| Env | `TRUENAS_URL=wss://192.168.1.36:8444/websocket`, `TRUENAS_API_KEY=<key>`, `ADMIN_PASSWORD=<pw>`, `HTTP_PORT=8080`, `DRY_RUN=1` (initially) |
| Port | forward `8080` |
| Storage | host path (e.g. `/mnt/Main_pool/apps/fleetdeck`) → mount at `/data` |

Or run anywhere with `docker compose up -d` (see `docker-compose.yml`).

## Development

```sh
npm install
npm test          # 41 tests: unit + full-stack integration against a mock TrueNAS
ADMIN_PASSWORD=dev npm start
```

`test/mock-truenas.js` is a stateful in-process fake of the box (legacy `/websocket` protocol, ZFS clone/iSCSI emulation) — useful for hacking on the UI without touching real hardware.

## Non-goals (v1)

No TFTP serving, no WinPE/wimboot hosting, no DHCP, no multi-server support, no user roles. One container, one file DB, boringly reliable.
