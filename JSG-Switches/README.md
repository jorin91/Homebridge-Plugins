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

```json
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

Each device supports an optional `id`.

When `id` is missing, the plugin uses the same name-based ID method as earlier versions. It lowercases the name, converts spaces, `_`, and `-` to `-`, keeps only lowercase letters, digits, and `-`, removes other characters, collapses repeated `-`, and trims leading or trailing `-`.

During the first startup with this version, that fallback ID matches the already cached accessory created by an earlier version. The plugin then writes the generated ID into Homebridge `config.json`.

When `id` is already present, that value is authoritative. Changes to `name` or other device settings keep updating the same accessory.

If multiple devices generate the same ID, later generated IDs receive deterministic suffixes such as `-1` and `-2` based on config order. Configured IDs must be unique.

Changing or removing a saved `id` changes the accessory identity.

## Scheduled Switches

Scheduled switches live in `scheduledSwitches`.

```json
{
  "id": "pool-pump-schedule",
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

```json
{
  "id": "manual-mode",
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

```json
{
  "id": "interval-toggle",
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

```json
{
  "id": "maintenance-timer",
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

The example below shows every supported property as strict JSON.

```json
{
  "platform": "JSG-Switches",
  "name": "JSG-Switches",
  "scheduledSwitches": [
    {
      "id": "pool-pump-schedule",
      "name": "Pool Pump Schedule",
      "defaultState": false,
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
        }
      ]
    }
  ],
  "switches": [
    {
      "id": "manual-mode",
      "name": "Manual Mode",
      "state": false
    }
  ],
  "intervalSwitches": [
    {
      "id": "interval-toggle",
      "name": "Interval Toggle",
      "state": false,
      "intervalMinutes": 15,
      "startTime": "00:00"
    }
  ],
  "timerSwitches": [
    {
      "id": "maintenance-timer",
      "name": "Maintenance Timer",
      "defaultState": false,
      "durationMinutes": 30
    }
  ]
}
```

Config fields:

- `platform` must be `JSG-Switches`.
- `name` is a label for the platform config block.
- `scheduledSwitches` contains scheduled virtual switches.
- `switches` contains plain virtual switches.
- `intervalSwitches` contains interval-based virtual switches.
- `timerSwitches` contains one-shot timer switches.
- Device `id` is optional. Missing IDs are generated from `name`, matched to existing cached accessories, and written back to Homebridge `config.json`.
- A saved `id` is the stable accessory identity and must remain unchanged when renaming or editing a device.
- Device `name` values are required display names and no longer determine identity after an ID has been saved.
- `defaultState` is used by scheduled and timer switches.
- `state` is used by plain and interval switches as the start state when no persisted runtime state exists.
- `enableIntervalCheck` only applies to scheduled switches.
- `intervalMinutes` controls schedule checks on scheduled switches and state flips on interval switches.
- `durationMinutes` controls when a timer switch returns to `defaultState`.
- `startTime` is optional for interval switches and uses local `HH:mm` time.
- `entries` contains scheduled switch ranges.
- `entries[].days` may be omitted or empty for every day.
- `entries[].start` and `entries[].end` use local `HH:mm` time.
## Installation And Updates

### Install Or Update Without Local Git

Install or update the global package from the current plugin release:

[JSG-Switches-v0.1.5](https://github.com/jorin91/Homebridge-Plugins/releases/tag/JSG-Switches-v0.1.5)

```powershell
npm install -g "https://github.com/jorin91/Homebridge-Plugins/releases/download/JSG-Switches-v0.1.5/JSG-Switches-0.1.5.tgz"
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

