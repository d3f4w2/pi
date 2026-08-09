# ADR 0021: Bilingual interface controlled by one language setting

## Status

Accepted

## Problem

Pi-go currently mixes English and Chinese strings directly inside TUI components and built-in extensions. A visual redesign that only replaces individual strings creates inconsistent screens, makes terminal-width bugs likely, and gives users no stable language preference.

## Decision

Add one global `language` setting with three stored values:

- `auto`: follow the operating-system locale;
- `zh-CN`: Simplified Chinese;
- `en`: English.

The setting is global because language is a user preference, not a project decision. Invalid or missing values resolve to `auto`. Automatic detection recognizes locales beginning with `zh`; every other locale resolves to English.

User-facing Pi-go copy is addressed through typed message keys. English is the complete fallback dictionary, while the Chinese dictionary must contain the same keys. Variables are interpolated after lookup. Code, paths, tool output, provider errors, and model responses remain unchanged.

Changing `language` in the settings screen persists immediately and updates newly rendered UI without restarting. Existing transcript content is not rewritten.

## Terminal rules

- Layout uses visible terminal width, not JavaScript string length.
- Both languages use the same semantic symbols: `›`, `│`, `✓`, and `×`.
- Chinese and English copy stay short; translated labels may differ in character count.
- Narrow-width tests cover both languages.
- Missing translations fall back to English instead of exposing a key or crashing.

## Consequences

The first implementation introduces the setting, locale resolution, typed dictionaries, and bilingual settings UI. Other TUI surfaces and built-in extensions migrate to the same message layer in bounded groups. New user-facing strings must not be hard-coded in localized components.
