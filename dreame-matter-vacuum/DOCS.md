# Dreame Matter Vacuum

Exposes one Dreame robot vacuum from Home Assistant as a **standalone Matter
Robotic Vacuum Cleaner**. Apple Home then shows the real vacuum accessory:
start, pause and "send to dock" buttons, a room picker, a cleaning-mode picker
with intensity, battery and charging state, and "Play sound" to find the robot.

## Requirements

- The vacuum set up through the [Dreame Vacuum](https://github.com/Tasshack/dreame-vacuum)
  custom integration (HACS). The vacuum entity must show a `rooms` attribute
  (open the map once in the Dreame app if it is missing).
- Home Assistant OS or Supervised.
- Every Apple Home hub (HomePod, Apple TV) on iOS / tvOS / audioOS **18.4 or
  newer**. The room and cleaning-mode pickers are part of the iOS 26 Home app.
- The add-on runs with host networking so mDNS and Matter UDP (default port
  5540) reach your Apple hubs. If another Matter server (for example the
  Matter Hub add-on) already runs on the host, change **Matter port**.

## Configuration

| Option | Meaning |
| --- | --- |
| `vacuum_entity` | The Dreame vacuum entity, e.g. `vacuum.dreame_l10`. Required. |
| `device_name` | Name shown in Apple Home. |
| `cleaning_mode_entity` | Dreame cleaning mode select. Auto-detected (`select.<vacuum>_cleaning_mode`). |
| `suction_level_entity` | Suction level select. Auto-detected. |
| `water_volume_entity` | Water volume / mop humidity select. Auto-detected. |
| `selected_map_entity` | Selected map select, used to switch floors before cleaning rooms of another map. Auto-detected. |
| `include_unnamed_rooms` | Also expose rooms the Dreame app has not named ("Room 7"). |
| `on_off_cluster` | Adds an On/Off cluster. Amazon Alexa needs it; leave off for Apple Home. |
| `matter_port` | UDP port of the Matter node (default 5540). |
| `mdns_interface` | Restrict announcements to one interface, e.g. `eth0`. |
| `log_level` | `debug`, `info`, `warn` or `error`. |

Auto-detection looks for `select` entities on the same Home Assistant device
as the vacuum and falls back to the Dreame integration's default entity ids.

## Pairing with Apple Home

1. Start the add-on and open its panel from the sidebar (**Matter Vacuum**).
   The page shows the pairing QR code and the manual code.
2. In the Home app tap **+ → Add Accessory** and scan the QR code. Accept the
   "uncertified accessory" warning.
3. Assign the vacuum to a room. The tile offers Start / Pause / Dock; the
   detail view offers rooms and cleaning modes.

To pair again (new home, reset), use **Factory reset** on the add-on page and
remove the accessory from the Home app.

## What maps to what

| Home app | Home Assistant |
| --- | --- |
| Start | `vacuum.start`, or `dreame_vacuum.vacuum_clean_segment` with the selected rooms |
| Pause / Resume | `vacuum.pause` / `vacuum.start` |
| Send to dock | `vacuum.return_to_base` |
| Rooms | Dreame `rooms` attribute of the selected map; other maps appear as floors and are switched automatically |
| Vacuum / Mop / Vacuum and mop / Deep clean | Dreame cleaning mode select (Sweeping / Mopping / Sweeping and mopping / Mopping after sweeping) |
| Intensity Quiet / Automatic / Max | Suction level while vacuuming, water volume while mopping |
| Battery, charging | `battery_level` and `charging` attributes |
| Play sound | `vacuum.locate` |

Room progress (pending, cleaning, done) follows the vacuum's `current_segment`.
Errors from the robot are reported as Matter error states (dust bin full,
water tank missing, stuck, cannot find dock, ...).

## Troubleshooting

- **Vacuum does not appear in the Home app**: all hubs must be on 18.4+, the
  add-on must be reachable on the LAN (host network, UDP 5540, mDNS). Check
  the add-on log for `Matter node online`.
- **No rooms**: the vacuum entity has no `rooms` attribute yet. Open the map in
  the Dreame app, then restart the add-on. New rooms appear without re-pairing.
- **No cleaning modes**: the cleaning-mode select was not found. Set
  `cleaning_mode_entity` explicitly.
- **Apple Home says "Updating"**: usually a network problem between hub and
  Home Assistant host. Make sure multicast/mDNS is allowed between the VLANs.
- Set `log_level` to `debug` to see every state update and service call.
