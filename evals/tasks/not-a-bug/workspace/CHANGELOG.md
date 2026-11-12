# Changelog

## 2.4.0 (2026-09-30)

- `formatDuration` accepts fractional seconds and rounds them.
- Units are case-insensitive (`"1H"`).

## 2.3.0 (2026-06-14)

- Fixed: compound durations kept only their last part, read as seconds, so `"1h30m"` gave 90 instead of 5400.
  Every part is now converted by its own unit and summed.
- `d` (days) is a unit.

## 2.2.1 (2026-03-02)

- Whitespace around the input is ignored.

## 2.2.0 (2026-02-10)

- Compound durations (`"1h30m"`).
