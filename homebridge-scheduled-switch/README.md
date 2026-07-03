# homebridge-scheduled-switch

`homebridge-scheduled-switch` is a Homebridge platform plugin that creates one or more neutral virtual switches. Each switch follows its own local weekly schedule and can be used as an automation trigger for a real device, such as a pump, relay, smart plug, light, heater, or any other accessory controlled elsewhere.

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

The example below shows every supported property. It is written as JSONC so each property can be explained inline. Remove the `//` comments if your Homebridge editor only accepts strict JSON.

```jsonc
{
  "platform": "ScheduledSwitch", // Required. Homebridge platform name registered by this plugin.
  "devices": [ // Required. List of virtual switches this platform should create.
    {
      "id": "pool-pump-schedule", // Optional but recommended. Stable accessory ID. Keep unchanged when renaming the switch.
      "name": "Pool Pump Schedule", // Required. Display name for this virtual switch.
      "inverseState": false, // Optional. False means ranges are on. True means ranges are off and outside ranges is on.
      "enableIntervalCheck": false, // Optional. When true, the schedule is also re-applied on the interval grid.
      "intervalMinutes": 15, // Optional. Interval-check size from 1 to 1440 minutes. Only used when enableIntervalCheck is true.
      "entries": [ // Required. Schedule ranges. By default these ranges represent when the switch is on.
        {
          "days": ["mon", "tue", "wed", "thu", "fri"], // Optional. Entry start days. Omit or use [] for every day.
          "start": "08:00", // Required per entry. Local 24-hour time where the range starts.
          "end": "10:00" // Required per entry. Local 24-hour time where the range ends.
        },
        {
          "days": ["sat", "sun"], // Weekend-only entry.
          "start": "22:00", // Overnight ranges are allowed when end is earlier than start.
          "end": "01:30" // This keeps the range active until 01:30 on the next calendar day.
        },
        {
          "days": ["wed"], // One selected day.
          "start": "00:00", // Equal start and end values mean the range is active for the full configured day.
          "end": "00:00"
        }
      ]
    },
    {
      "id": "inverted-ventilation-schedule", // Optional stable ID for this second virtual switch.
      "name": "Inverted Ventilation Schedule", // Required display name.
      "inverseState": true, // Optional. This switch is off during the configured range and on outside it.
      "enableIntervalCheck": true, // Optional. Manual changes are corrected at the next interval check.
      "intervalMinutes": 30, // Optional. Checks at local :00 and :30 when interval checks are enabled.
      "entries": [ // Required schedule ranges for this device.
        {
          "days": [], // Optional. Empty array means every day.
          "start": "18:00", // Required per entry.
          "end": "23:00" // Required per entry.
        }
      ]
    }
  ]
}
```

## Config Notes

- Valid day values are `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, and `sun`.
- `entries[].start` and `entries[].end` must use strict local `HH:mm` 24-hour time.
- `id` should stay stable once the accessory exists. Changing it creates a new accessory identity.

## Installation And Updates

### Install Without Local Git

Install the published `homebridge-scheduled-switch` package asset from the latest GitHub release:

[Latest release](https://github.com/jorin91/Homebridge-Plugins/releases/latest)

```powershell
$release = Invoke-RestMethod "https://api.github.com/repos/jorin91/Homebridge-Plugins/releases/latest"
$asset = $release.assets | Where-Object { $_.name -like "homebridge-scheduled-switch-*.tgz" } | Select-Object -First 1
npm install -g $asset.browser_download_url
```

### Update Without Local Git

Install the latest published package asset over the existing global package:

```powershell
$release = Invoke-RestMethod "https://api.github.com/repos/jorin91/Homebridge-Plugins/releases/latest"
$asset = $release.assets | Where-Object { $_.name -like "homebridge-scheduled-switch-*.tgz" } | Select-Object -First 1
npm install -g $asset.browser_download_url
```

### Install With Local Git

Clone the repository and install the plugin from its own folder:

```powershell
git clone https://github.com/jorin91/Homebridge-Plugins.git
cd Homebridge-Plugins\homebridge-scheduled-switch
npm install -g .
```

### Update With Local Git

Pull the latest repository changes, then reinstall the plugin from its folder so the global Homebridge installation points at the updated local code:

```powershell
cd Homebridge-Plugins
git pull
cd homebridge-scheduled-switch
npm install -g .
```

### Uninstall

```powershell
npm uninstall -g homebridge-scheduled-switch
```


