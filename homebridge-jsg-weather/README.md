# homebridge-jsg-weather

`homebridge-jsg-weather` is a Homebridge platform plugin for presenting mapped weather values on exactly one weather accessory. It reads one remote source, maps selected values through supported measurement units, and keeps every named measurement together on the same accessory.

The plugin is source-provider independent. A source URL can point to any compatible endpoint. The selected source format determines how the response and mapping paths are interpreted.

Some weather values use custom HomeKit characteristics. A compatible third-party HomeKit app may be needed to display or automate those characteristics. Apple's Home app does not expose every custom characteristic, but the plugin still assigns HomeKit read and notification permissions according to the automation contract described below.

## Features

- Creates at most one weather accessory from one platform config block
- Reads one source for every configured weather value
- Uses a stable internal accessory identity that survives restarts and display-name changes
- Keeps provider details out of the plugin logic
- Selects the source parser through `sourceType`
- Supports JSON sources in the current version
- Uses mappings containing exactly a user-chosen `name`, supported `unit`, and source `path`
- Allows the same unit to be mapped repeatedly under different measurement names
- Polls every five minutes by default
- Prevents overlapping source requests
- Keeps network requests outside HomeKit read handlers
- Uses a unit-specific neutral value when a configured value cannot be read
- Makes numeric values and fixed-set values notification-capable for compatible HomeKit automation clients
- Keeps free-form informational text readable without advertising it as automation input

## Accessory Behavior

Every valid mapping is presented as one service under the same weather accessory. Mappings never create additional accessories. The measurement name is configured by the user and is shown without plugin-side translation, so values sharing a unit can remain recognizable as separate weather aspects.

The accessory is created only when at least one mapping is valid. When no valid mappings remain, the plugin does not create or retain the accessory. The accessory identity is generated internally and does not require a configurable ID.

Each service receives a deterministic internal identity derived from its `unit` and `name`. This lets the service survive restarts and path changes. Renaming a measurement intentionally changes that service identity, so HomeKit can treat the renamed measurement as a replacement service; it does not replace the single accessory itself.

## Source Architecture

`sourceType` selects the component that parses the source response and resolves mapping paths. Only `json` is currently implemented. Additional formats can be added through their own source handler without changing the platform or accessory lifecycle.

The `source` value is the complete URL requested by the plugin. It may include provider-specific path segments and query parameters. The platform itself does not assume a particular weather provider or response structure.

For JSON sources, a mapping path can use dot and array notation such as `observations[0].metric.temp` or JSON Pointer notation such as `/observations/0/metric/temp`.

One successful response is parsed once and used to update every mapping. If the request or response fails, each mapping receives the neutral value defined for its unit instead of retaining stale data.

## Complete Config Example

The example below shows every supported property as strict JSON.

```json
{
  "platform": "JsgWeather",
  "sourceType": "json",
  "source": "https://api.example.test/weather.json",
  "interval": 5,
  "name": "Weather",
  "mappings": [
    {
      "name": "Temperature",
      "unit": "°C",
      "path": "/current/temperature_2m"
    },
    {
      "name": "Dew Point",
      "unit": "°C",
      "path": "/current/dew_point_2m"
    }
  ]
}
```

Config fields:

- `platform` must be `JsgWeather`
- `sourceType` selects the response format handler. The current supported value is `json`
- `source` is the complete URL for the single weather data source
- `interval` is the polling interval in minutes. It defaults to `5` when omitted or invalid
- `name` optionally changes the display name of the weather accessory. It defaults to `Weather`
- `mappings` contains all weather values to expose on the single accessory
- `mappings[].name` is the user-chosen, untranslated label shown for the measurement
- `mappings[].unit` selects the built-in behavior for the source value's unit
- `mappings[].path` locates the source value using the path rules of the selected source type

Each mapping requires exactly `name`, `unit`, and `path`. IDs, formatting rules, transforms, thresholds, fallbacks, and automation settings are not configurable mapping properties. The plugin owns validation, normalization, characteristic metadata, and the neutral value for every supported unit.

Supported unit keys are deliberately compact and match the units returned by Open-Meteo or describe a built-in wind-direction conversion:

- `1` for dimensionless values and values whose Open-Meteo unit is blank or `undefined`
- `%`
- `°` for a numeric direction in degrees without conversion
- `compass16` for a 16-point compass string without changing its representation
- `compass16->°` for converting a 16-point compass string to its sector-center angle
- `°->compass16` for converting degrees to the canonical Dutch 16-point compass notation
- `°C`
- `°F`, available when Open-Meteo is configured for Fahrenheit output
- `cm`
- `GGDc`
- `h`
- `hPa`
- `in`, available when Open-Meteo is configured for inch precipitation output
- `iso8601`
- `J/kg`
- `kg/m²`
- `km/h`
- `kn`, available when Open-Meteo is configured for knot wind output
- `kPa`
- `m`
- `m/s`
- `m³/m³`
- `MJ/m²`
- `mm`
- `mph`, available when Open-Meteo is configured for miles-per-hour wind output
- `ms`, used for Open-Meteo `generationtime_ms`
- `s`, used for Open-Meteo values reported as either `s` or `seconds`
- `W/m²`
- `WMO`, used for Open-Meteo `wmo code` weather values

The complete canonical Dutch compass sequence, clockwise from north, is `N`, `NNO`, `NO`, `ONO`, `O`, `OZO`, `ZO`, `ZZO`, `Z`, `ZZW`, `ZW`, `WZW`, `W`, `WNW`, `NW`, `NNW`. `NWW` is not a valid 16-point direction; the correct west-northwest abbreviation is `WNW`.

`compass16` and `compass16->°` accept that Dutch notation as well as the international aliases `N`, `NNE`, `NE`, `ENE`, `E`, `ESE`, `SE`, `SSE`, `S`, `SSW`, `SW`, `WSW`, `W`, `WNW`, `NW`, and `NNW`. Matching is case-insensitive and ignores separating spaces, hyphens, and underscores. Text output is always normalized to the Dutch sequence.

`compass16->°` returns the center of the matching compass sector: `N` is 0°, `NNO` is 22.5°, `O` is 90°, `Z` is 180°, and `W` is 270°. `°->compass16` accepts finite values from 0 through 360 degrees, with 360 treated as north. Its sector changes occur at 11.25° plus multiples of 22.5°: 11.25° becomes `NNO`, 33.75° becomes `NO`, and 348.75° through 360° becomes `N`.

## HomeKit Automation Behavior

Automation behavior belongs internally to the registered unit definition and cannot be changed per mapping. This classification adds no configuration property. It is based on the meaning and value domain of the output, rather than on whether its JavaScript representation happens to be numeric or textual.

Numeric units expose an actual HomeKit number. The unit symbol is characteristic metadata and is never appended to the value itself: a temperature is exposed as `21.5`, not as the string `21.5 °C`. Numeric characteristics are readable and notification-capable (`pr` and `ev`), so a compatible HomeKit client can create equality, lower-than, or higher-than conditions using the raw number.

Values from a fixed discrete set are also readable and notification-capable and are intended for exact equality conditions. In particular, `compass16` and `°->compass16` expose exactly one canonical Dutch value: `N`, `NNO`, `NO`, `ONO`, `O`, `OZO`, `ZO`, `ZZO`, `Z`, `ZZW`, `ZW`, `WZW`, `W`, `WNW`, `NW`, or `NNW`. A condition such as wind direction equals `WNW` is therefore the intended comparison.

HomeKit's `validValues` metadata is numeric and cannot advertise a list of permitted strings or supply a native compass dropdown. The plugin can consequently normalize compass text to the fixed list, but it cannot require every controller UI to present that list. A compatible external HomeKit app such as Home+ may be required to expose the characteristic and create the exact string-equality automation. Home+ is only an example controller interface used to view the characteristic and configure the rule: the plugin has no Home+ integration or dependency, and the resulting rule remains a HomeKit/Home Hub automation. See the official HAP-NodeJS definitions for [characteristic properties](https://developers.homebridge.io/HAP-NodeJS/interfaces/CharacteristicProps.html) and [permissions](https://developers.homebridge.io/HAP-NodeJS/enums/Perms.html), and the official [Home+ automation documentation](https://hochgatterer.me/home%2B/docs/features/automations/).

Free-form informational text is readable (`pr`) but not notification-capable and has no automation guarantee. The current example is `iso8601`, used by the private configuration for the `Datatijd` source-validity value. Future unit definitions must use the same rule: bounded numeric or fixed-set outputs are automatable; unbounded informational text is display-only.

All of these values remain HomeKit characteristics, but Apple's Home app may not display or expose every custom characteristic. A compatible third-party HomeKit client can therefore be needed to view or automate them.

## Installation And Updates

### Install Or Update Without Local Git

Install or update the global package from the current plugin release:

[homebridge-jsg-weather-v0.1.0](https://github.com/jorin91/Homebridge-Plugins/releases/tag/homebridge-jsg-weather-v0.1.0)

```powershell
npm install -g "https://github.com/jorin91/Homebridge-Plugins/releases/download/homebridge-jsg-weather-v0.1.0/homebridge-jsg-weather-0.1.0.tgz"
```

### Install With Local Git

Clone the repository and install the plugin from its own folder:

```powershell
git clone https://github.com/jorin91/Homebridge-Plugins.git
cd Homebridge-Plugins\homebridge-jsg-weather
npm install -g .
```

### Update With Local Git

Pull the latest repository changes, then reinstall the plugin from its folder:

```powershell
cd Homebridge-Plugins
git pull
cd homebridge-jsg-weather
npm install -g .
```

### Uninstall

```powershell
npm uninstall -g homebridge-jsg-weather
```
