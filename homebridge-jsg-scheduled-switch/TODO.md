# TODO

## Device Types

- Add a `type` property per device and route behavior based on that type.
- Add `scheduled-switch` for the current time-clock behavior. Replace `inverseState` with `defaultState`. `defaultState` is the state outside active schedule ranges and defaults to `false`. During an active schedule range the switch publishes the opposite state.
- Add `switch` for a plain virtual switch with no logic behind it. Homebridge and HomeKit automations can set its on or off state directly.
- Add `interval-switch` for a virtual switch that flips state on a configured minute interval. The first interval is calculated from the current `xx:00` hour boundary when the device starts. Later interval moments may drift from the clock grid.
- Add `timer-switch` for a virtual switch with a `defaultState`. When the switch changes away from `defaultState`, it stays there for the configured number of minutes and then returns to `defaultState`. The timer starts at the moment of switching.