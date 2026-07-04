# JSG-Switches

`JSG-Switches` is a Homebridge platform plugin that creates neutral virtual switch accessories. It supports plain switches, scheduled switches, interval switches, and timer switches from one platform config block.

The plugin does not control physical devices directly. It exposes virtual switch states through Homebridge. Automations decide what should happen when a virtual switch turns on or off.

## Features

- Creates multiple virtual switch accessories from typed config arrays.
- Keeps each switch type in its own array for a consistent object shape.
- Generates accessory IDs automatically from each device name.
- Supports scheduled switches with weekly local time ranges.
- Supports plain switches with persisted runtime state.
- Supports interval switches that flip state on a configured interval.
- Supports timer switches that return to an inactive default state after a duration.

## Config Shape

Use one array per switch behavior:

```jsonc
{
  "platform": "JSG-Switches",
  "name": "JSG-Switches",
  "scheduledSwitches": [],
  "switches": [],
  "intervalSwitches": [],
  "timerSwitches": []
}
```

`name` is only a label for the platform config block. Device names belong inside the typed arrays.

## Accessory IDs

Accessory IDs are generated from each device `name`.

The plugin lowercases the name, converts spaces, `_`, and `-` to `-`, keeps only lowercase letters, digits, and `-`, removes other characters, collapses repeated `-`, and trims leading or trailing `-`.

If multiple devices generate the same ID, the later devices receive deterministic suffixes such as `-1` and `-2` based on config order.

Renaming a device changes the generated accessory ID.

## Scheduled Switches

Scheduled switches live in `scheduledSwitches`.

```jsonc
{
  "name": "Pool Pump Schedule",
  "defaultState": false,
  "enableIntervalCheck": false,
  "intervalMinutes": 15,
  "entries": [
    {
      "days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      "start": "20:00",
      "end": "21:00"
    }
  ]
}
```

Behavior:

- `defaultState` is the state outside active schedule ranges.
- During an active range, the switch publishes the opposite of `defaultState`.
- Manual changes stay active until the next configured start or end trigger.
- `enableIntervalCheck` can also re-apply the schedule between start and end triggers.
- Interval checks are aligned from local `00:00`.
- `entries[].days` accepts `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, and `sun`.
- Missing or empty `entries[].days` means every day.
- `entries[].start` and `entries[].end` use local `HH:mm` time.
- If `end` is earlier than `start`, the range continues after midnight.
- If `start` equals `end`, the range is active for the full configured day.

## Switches

Plain switches live in `switches`.

```jsonc
{
  "name": "Manual Mode",
  "state": false
}
```

Behavior:

- No schedule logic.
- No interval logic.
- No timer logic.
- `state` is the configured start state when no persisted runtime state exists.
- Runtime changes are saved by the plugin and survive Homebridge restarts.
- The plugin does not write normal switch changes back to `config.json`.

## Interval Switches

Interval switches live in `intervalSwitches`.

```jsonc
{
  "name": "Interval Toggle",
  "state": false,
  "intervalMinutes": 15,
  "startTime": "00:00"
}
```

Behavior:

- `state` is the configured start state when no persisted runtime state exists.
- Runtime changes are saved by the plugin and survive Homebridge restarts.
- `intervalMinutes` controls how often the state flips.
- `startTime` is optional and uses local `HH:mm` time.
- Without `startTime`, the interval is counted from the moment the accessory becomes active.
- With `startTime`, interval moments are counted from that local start time.
- Manual changes are allowed. The next interval flip continues from the current state.

## Timer Switches

Timer switches live in `timerSwitches`.

```jsonc
{
  "name": "Maintenance Timer",
  "defaultState": false,
  "durationMinutes": 30
}
```

Behavior:

- `defaultState` is the inactive state.
- Changing the switch to a state different from `defaultState` starts the timer.
- After `durationMinutes`, the switch returns to `defaultState`.
- Changing the switch back to `defaultState` before the timer ends stops the active timer.
- Timer switches do not have interval, repeat, extend, or schedule behavior.

## Complete Config Example

The example below shows every supported property. It is written as JSONC so each property can be explained inline. Remove the `//` comments if your Homebridge editor only accepts strict JSON.

```jsonc
{
  "platform": "JSG-Switches", // Required. Homebridge platform name registered by this plugin.
  "name": "JSG-Switches", // Optional. Label for this platform config block.
  "scheduledSwitches": [ // Scheduled virtual switches.
    {
      "name": "Pool Pump Schedule", // Required. Display name and source for the generated accessory ID.
      "defaultState": false, // Optional. State outside active schedule ranges.
      "enableIntervalCheck": false, // Optional. When true, schedule state is also re-applied on the interval grid.
      "intervalMinutes": 15, // Optional. Interval check size from 1 to 1440 minutes.
      "entries": [ // Required. Schedule ranges.
        {
          "days": ["mon", "tue", "wed", "thu", "fri"], // Optional. Omit or use [] for every day.
          "start": "08:00", // Required per entry. Local range start time.
          "end": "10:00" // Required per entry. Local range end time.
        },
        {
          "days": ["sat", "sun"], // Weekend-only entry.
          "start": "22:00", // Overnight ranges are allowed.
          "end": "01:30" // This keeps the range active until 01:30 on the next calendar day.
        }
      ]
    }
  ],
  "switches": [ // Plain virtual switches.
    {
      "name": "Manual Mode", // Required. Display name and source for the generated accessory ID.
      "state": false // Required. Start state when no persisted runtime state exists.
    }
  ],
  "intervalSwitches": [ // Virtual switches that flip state on an interval.
    {
      "name": "Interval Toggle", // Required. Display name and source for the generated accessory ID.
      "state": false, // Required. Start state when no persisted runtime state exists.
      "intervalMinutes": 15, // Required. Minutes between state flips.
      "startTime": "00:00" // Optional. Local HH:mm anchor for interval calculation.
    }
  ],
  "timerSwitches": [ // Virtual one-shot timer switches.
    {
      "name": "Maintenance Timer", // Required. Display name and source for the generated accessory ID.
      "defaultState": false, // Required. Inactive state.
      "durationMinutes": 30 // Required. Minutes before returning to defaultState.
    }
  ]
}
```

## Installation And Updates

### Install Or Update Without Local Git

Install or update the global package from the current plugin release:

[JSG-Switches-v0.1.0](https://github.com/jorin91/Homebridge-Plugins/releases/tag/JSG-Switches-v0.1.0)

```powershell
npm install -g "https://github.com/jorin91/Homebridge-Plugins/releases/download/JSG-Switches-v0.1.0/JSG-Switches-0.1.0.tgz"
```

### Install With Local Git

Clone the repository and install the plugin from its own folder:

```powershell
git clone https://github.com/jorin91/Homebridge-Plugins.git
cd Homebridge-Plugins\JSG-Switches
npm install -g .
```

### Update With Local Git

Pull the latest repository changes, then reinstall the plugin from its folder so the global Homebridge installation points at the updated local code:

```powershell
cd Homebridge-Plugins
git pull
cd JSG-Switches
npm install -g .
```

### Uninstall

```powershell
npm uninstall -g homebridge-jsg-switches
```