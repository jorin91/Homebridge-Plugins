# homebridge-jsg-scheduled-switch

`homebridge-jsg-scheduled-switch` is a Homebridge platform plugin that creates one or more neutral virtual switches. Each switch follows its own local weekly schedule and can be used as an automation trigger for a real device, such as a pump, relay, smart plug, light, heater, or any other accessory controlled elsewhere.

The plugin does not talk to physical devices directly. It exposes scheduled virtual switches through Homebridge. Automations decide what should happen when a virtual switch turns on or off.

## Features

- Creates multiple scheduled virtual switches from one Homebridge platform config block.
- Uses local weekly time ranges with `HH:mm` start and end times.
- Treats configured ranges as `on` by default and outside those ranges as `off`.
- Supports `inverseState` per device, where configured ranges become `off` and outside those ranges becomes `on`.
- Supports daily, selected-day, overnight, and full-day schedule ranges.
- Supports stable per-device IDs so accessories can survive display-name changes.
- Allows manual changes until the next configured schedule trigger.
- Can optionally re-apply the schedule on a fixed local interval grid, such as every 15 minutes.

## Accessory IDs

Each device supports an optional `id`. Configuration stores only the stable base identity path. The code-owned plugin namespace is added when the complete Homebridge UUID seed is assembled. Every scheduled-switch device represents one logical accessory, so the seed uses `${effectivePluginNamespace}:${id}` without a type segment.

When the `id` property exists, its canonical value is authoritative. The complete value becomes lowercase, whitespace becomes `-`, and every character except `a` through `z`, `0` through `9`, `-`, and `:` is removed. Repeated and edge `-` characters are removed inside every segment. A `:` remains a structural separator, so `schedule:morning` is a valid multi-segment base path while leading, trailing, or repeated colons are invalid. The first base segment may not repeat the code-owned effective plugin namespace because the complete seed does not belong in config. The canonical value is written back only when it differs exactly from the stored JSON string.

An existing empty, non-string, or unusable `id` is a configuration error. The plugin does not replace an invalid present value from the device name.

Only when the `id` property is genuinely absent does the plugin generate a base ID from the device name and immediately store it in Homebridge `config.json`. For example, `Coffee Schedule` generates `coffee-schedule`, not a plugin-prefixed config value. Generated duplicates receive deterministic suffixes such as `-1` and `-2` in device-array order. Explicit configured IDs must be unique.

Existing saved IDs from earlier releases remain authoritative after canonical normalization. A value such as `jsg-scheduled-switch-coffee` is not rewritten merely because new automatic IDs no longer include that prefix.

Reconciliation checks current structured identity context first, then the current UUID, then supported older context and UUID candidates. A matched cached accessory keeps its actual Homebridge UUID while receiving current context. This preserves rooms, scenes, automations, and downstream references through normalization and plugin identity updates.

After an ID has been saved, changes to `name` or schedule settings continue updating the same accessory. Explicitly changing or removing that saved `id` is an identity change.
## Schedule Behavior

- With `inverseState: false`, the switch is on inside any configured range and off outside all ranges.
- With `inverseState: true`, the switch is off inside any configured range and on outside all ranges.
- If `end` is earlier than `start`, the schedule range continues after midnight.
- If `start` equals `end`, the schedule range is active for the full configured day.
- Manual changes stay active until the next configured start or end trigger.
- `enableIntervalCheck` can correct manual changes before the next start or end trigger.
- Interval checks are aligned from local `00:00`. For example, `15` checks at `:00`, `:15`, `:30`, and `:45`.

## Automation Pattern

Create two automations for each virtual switch you want to use:

1. When the virtual schedule switch turns on, turn the physical smart switch on.
2. When the virtual schedule switch turns off, turn the physical smart switch off.

The plugin itself never talks to the physical device. It only exposes scheduled virtual switch states through Homebridge.

## Complete Config Example

The example below shows every supported property as strict JSON.

```json
{
  "platform": "JsgScheduledSwitch",
  "devices": [
    {
      "id": "pool-pump-schedule",
      "name": "Pool Pump Schedule",
      "inverseState": false,
      "enableIntervalCheck": false,
      "intervalMinutes": 15,
      "entries": [
        {
          "days": ["mon", "tue", "wed", "thu", "fri"],
          "start": "08:00",
          "end": "10:00"
        },
        {
          "days": ["sat", "sun"],
          "start": "22:00",
          "end": "01:30"
        },
        {
          "days": ["wed"],
          "start": "00:00",
          "end": "00:00"
        }
      ]
    },
    {
      "id": "inverted-ventilation-schedule",
      "name": "Inverted Ventilation Schedule",
      "inverseState": true,
      "enableIntervalCheck": true,
      "intervalMinutes": 30,
      "entries": [
        {
          "days": [],
          "start": "18:00",
          "end": "23:00"
        }
      ]
    }
  ]
}
```

Config fields:

- `platform` must be `JsgScheduledSwitch`.
- `devices` contains the virtual scheduled switches this platform should create.
- `id` is optional and stores only the authoritative canonical base identity path.
- An absent ID uses the canonical device-name path and is written back to Homebridge `config.json`. A present invalid ID is an error and is not generated again.
- Existing cached accessories matched through current or supported older identity context and UUID seeds retain their actual Homebridge UUID.
- `name` is the display name for the virtual switch and can change without replacing the accessory after an ID has been saved.
- `inverseState` false means ranges are on. True means ranges are off and outside ranges is on.
- `enableIntervalCheck` re-applies schedule state on the interval grid when enabled.
- `intervalMinutes` controls the optional interval check size.
- `entries` contains schedule ranges.
- `entries[].days` may be omitted or empty for every day.
- `entries[].start` and `entries[].end` use local `HH:mm` time.
## Config Notes

- Valid day values are `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, and `sun`.
- `entries[].start` and `entries[].end` must use strict local `HH:mm` 24-hour time.
- Existing configs without `id` receive a canonical name-derived base ID. Previous name-based and version 0.1.6 identity candidates remain lookup-only fallbacks so matched accessories keep their actual UUID.
- A saved `id` should stay stable. Changing or removing it creates a new accessory identity.
- The plugin only reads `devices`. Homebridge UI is normalized by the plugin settings UI so an empty config keeps `devices: []` visible.

## Installation And Updates

### Install Or Update Without Local Git

Install or update the global package from the current plugin release:

[homebridge-jsg-scheduled-switch-v0.1.7](https://github.com/jorin91/Homebridge-Plugins/releases/tag/homebridge-jsg-scheduled-switch-v0.1.7)

```powershell
npm install -g "https://github.com/jorin91/Homebridge-Plugins/releases/download/homebridge-jsg-scheduled-switch-v0.1.7/homebridge-jsg-scheduled-switch-0.1.7.tgz"
```

### Install With Local Git

Clone the repository and install the plugin from its own folder:

```powershell
git clone https://github.com/jorin91/Homebridge-Plugins.git
cd Homebridge-Plugins\homebridge-jsg-scheduled-switch
npm install -g .
```

### Update With Local Git

Pull the latest repository changes, then reinstall the plugin from its folder so the global Homebridge installation points at the updated local code:

```powershell
cd Homebridge-Plugins
git pull
cd homebridge-jsg-scheduled-switch
npm install -g .
```

### Uninstall

```powershell
npm uninstall -g homebridge-jsg-scheduled-switch
```

