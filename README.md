# Dreame Home Assistant HomeKit

Home Assistant add-on repository that makes a **Dreame robot vacuum** (L10,
L10 Pro, L10s and friends) show up in **Apple Home as a real robot vacuum**.

Apple Home has no HomeKit accessory type for vacuums; what it does support,
since iOS 18.4 and with the full room and mode pickers in iOS 26, is the
**Matter Robotic Vacuum Cleaner**. The add-on in this repository runs a
standalone Matter node that mirrors the Dreame vacuum from Home Assistant with
every cluster Apple Home uses:

| Home app | Matter cluster | Home Assistant |
| --- | --- | --- |
| Start / Pause / Resume / Send to dock | RvcRunMode, RvcOperationalState | `vacuum.start`, `vacuum.pause`, `vacuum.return_to_base`, or `dreame_vacuum.vacuum_clean_segment` for selected rooms |
| Room picker, floors, per-room progress | ServiceArea (Maps, ProgressReporting) | Dreame `rooms` attribute, `current_segment`, selected-map select |
| Vacuum / Mop / Vacuum and mop / Deep clean, with Quiet / Automatic / Max intensity | RvcCleanMode | Dreame cleaning mode, suction level and water volume selects |
| Battery, charging | PowerSource | `battery_level`, `charging` |
| Play sound | Identify | `vacuum.locate` |
| Errors (bin full, tank missing, stuck, ...) | RvcOperationalState errors | Dreame `error` attribute |

## Install

1. Home Assistant → Settings → Add-ons → Add-on Store → ⋮ → **Repositories**,
   add `https://github.com/John-Butler3/dreame-homeassistant-homekit`.
2. Install **Dreame Matter Vacuum**, set `vacuum_entity` to your Dreame vacuum
   (for example `vacuum.dreame_l10`), start it.
3. Open the add-on panel **Matter Vacuum** in the sidebar and scan the QR code
   with the Home app (**+ → Add Accessory**).

Full documentation: [dreame-matter-vacuum/DOCS.md](dreame-matter-vacuum/DOCS.md).

## Requirements

- Dreame vacuum working in Home Assistant through the
  [Dreame Vacuum (Tasshack)](https://github.com/Tasshack/dreame-vacuum) HACS
  integration.
- Home Assistant OS or Supervised (add-ons).
- All Apple Home hubs on iOS / tvOS / audioOS 18.4 or newer.

## Repository layout

```
repository.yaml                add-on repository descriptor
dreame-matter-vacuum/          the add-on
  config.yaml                  add-on options and schema
  Dockerfile, build.yaml       builds the Node.js app on install
  run.sh                       entry point
  DOCS.md                      user documentation (shown in the add-on UI)
  app/                         TypeScript source (matter.js + Home Assistant websocket)
    src/vacuum/model.ts        pure mapping Home Assistant -> Matter clusters
    src/vacuum/controller.ts   state tracking, room progress, actions
    src/matter/                Matter node and cluster behaviours
    src/ha/                    Home Assistant websocket client, helper detection
    src/web/                   pairing / status page served through ingress
```

## Development

```bash
cd dreame-matter-vacuum/app
npm install
npm test        # unit tests + an end-to-end test against a real matter.js node
npm run build
DMV_HA_URL=http://homeassistant.local:8123 DMV_HA_TOKEN=<long-lived token> \
DMV_VACUUM_ENTITY=vacuum.dreame_l10 DMV_STORAGE_PATH=./data npm start
```

## Alternatives

- [RiDDiX/home-assistant-matter-hub](https://github.com/RiDDiX/home-assistant-matter-hub)
  is a general-purpose Matter bridge add-on that also supports Dreame vacuums
  (Server Mode). Use it if you want to bridge many kinds of entities.
- For homes without Matter-capable Apple hubs, a HomeKit Bridge helper
  integration (separate project, `dreame_homekit`) exposes the vacuum as
  individual switches and fans through the classic HomeKit Bridge.
