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
- With `inverseState: false`, the switch is on inside any configured range and off outside all ranges.
- With `inverseState: true`, the switch is off inside any configured range and on outside all ranges.
- If `end` is earlier than `start`, the schedule range continues after midnight.
- If `start` equals `end`, the schedule range is active for the full configured day.
- `enableIntervalCheck` is useful when manual changes should be corrected automatically before the next start or end trigger.
- `id` should stay stable once the accessory exists. Changing it creates a new accessory identity.

## Install Without Local Git

Open the [GitHub Releases page](https://github.com/jorin91/Homebridge-Plugins/releases), choose the `homebridge-scheduled-switch` release you want, and copy or download its `.tgz` asset.

Install directly from the chosen asset URL:

```powershell
npm install -g "PASTE_CHOSEN_HOMEBRIDGE_SCHEDULED_SWITCH_TGZ_URL_HERE"
```

Or install after downloading the asset locally:

```powershell
npm install -g "C:\Path\To\homebridge-scheduled-switch.tgz"
```

## Install With Local Git

```powershell
git clone https://github.com/jorin91/Homebridge-Plugins.git
cd Homebridge-Plugins\homebridge-scheduled-switch
npm install -g .
```

## Update

Choose the newer `homebridge-scheduled-switch` `.tgz` asset from the [GitHub Releases page](https://github.com/jorin91/Homebridge-Plugins/releases), then run the same command-line install again:

```powershell
npm install -g "PASTE_CHOSEN_HOMEBRIDGE_SCHEDULED_SWITCH_TGZ_URL_HERE"
```

With a local git checkout:

```powershell
cd Homebridge-Plugins
git pull
cd homebridge-scheduled-switch
npm install -g .
```

## Uninstall

```powershell
npm uninstall -g homebridge-scheduled-switch
```

## Automation Pattern

Create two automations for each virtual switch you want to use:

1. When the virtual schedule switch turns on, turn the physical smart switch on.
2. When the virtual schedule switch turns off, turn the physical smart switch off.

The plugin itself never talks to the physical device. It only exposes scheduled virtual switch states through Homebridge.
