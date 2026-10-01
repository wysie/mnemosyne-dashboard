# Changelog

## Unreleased

- Add a database selector on the Overview page to switch between Mnemosyne databases at runtime without restarting.
- Discover Hermes profile brains automatically, or list databases explicitly with the new optional `db_paths` config; switching stays read-only and limited to the discovered set.

## 0.14.0

- Restore `?tab=history` compatibility by aliasing old history deep links to the current Activity view.
- Show auth-aware frontend boot diagnostics instead of treating every startup error as a login/password problem.
- Polish the dashboard visual design with calmer dark/light themes, cleaner navigation labels, and less noisy memory-card metadata.

## 0.13.1

- Rename user-facing memory trust review wording from “Contaminated” to “Needs review”.
- Keep backend/API compatibility with existing contamination fields and filters.

## 0.13.0

- Make Pattern insights use Mnemosyne's real `mnemosyne.core.PatternDetector.summarize_patterns()` output.
- Split dashboard-only domain taxonomy into a separate Context domains panel so fixed categories are no longer mislabeled as Mnemosyne patterns.

## 0.12.1

- Fix Pattern insights mobile header wrapping so the title no longer collapses into one letter per line.

## 0.12.0

- Upgrade Pattern insights into clickable horizontal bar charts with summary stats.
- Rename `Other` topics to `Unclassified` and hide noisy entity terms such as dates, generic system roles, API labels, and ID-like tokens.
- Split source-style aggregates into clearer `Origins` and `Memory types` panels.

## 0.11.4

- Remove one-off source memory cards from Pattern insights so the panel only shows aggregate recurring topics, entities, and sources.

## 0.11.3

- Remove the confusing Overview Memory stream diagnostics card; realtime diagnostics remain in Settings.

## 0.11.2

- Make the desktop sidebar independently scrollable so the Theme switch remains reachable on shorter viewports.
- Add spacing below the sidebar search box so it no longer touches the Overview nav card.

## 0.11.1

- Align Live memory stream event badges flush with the card content column.

## 0.11.0

- Add the Overview Live memory stream with infinite scroll and live badges for new, updated, recalled, invalidated, and consolidated memories.
- Add cross-process DB-polling signature detection so the dashboard can surface Mnemosyne 2.6 memory changes despite in-process-only native streams.
- Add Context Bank Pattern insights for recurring topics, entities, sources, and clickable source memory signals.

## 0.10.0

- Hide the experimental Mnemosyne Labyrinth/Memory Palace entry from the main sidebar while keeping the route and implementation available for direct testing.
- Ship the focused visualiser/review polish line as the main release surface: fullscreen visualisers, memory-name alignment improvements, Review pagination, and related dashboard fixes.

## 0.9.1

- Bump package/plugin release version to `0.9.1`.
- Keep the HTTP server header aligned with the project version (`MnemosyneDashboard/0.9.1`) instead of the old hardcoded `0.3` value.
- Refresh the GitHub screenshot gallery after the dashboard IA, search, review, lifecycle, and copy polish pass.
- Polish the dashboard for release: selected-item Review triage, sidebar command search, clearer Search results, empty/loading/error states, Facts wording, and shorter History copy.

## 0.6.1

- Polish the public dashboard UI for GitHub release quality: balanced mobile brand lockup, larger sidebar nav icons, softer theme switch styling, and refined hero headline spacing.
- Keep the hero headline to two desktop lines while disabling display ligatures so “finally” remains readable.
- Default the dashboard bind host to `0.0.0.0` for easier LAN access while keeping memory admin/editing disabled by default.
- Keep LAN/non-local memory admin mutations password-gated and audited.

## 0.6.0

- Add password-gated memory maintenance mode for safe Mnemosyne-aligned mutations.
- Add supersede, expire/invalidate, and importance update actions from the memory detail drawer.
- Add active/expired/superseded memory status pills and filters.
- Add automatic SQLite backups and JSONL audit log entries for every admin mutation.
- Add admin backup and audit log endpoints while keeping raw content overwrite and hard delete unavailable.

## 0.5.1

- Keep database diagnostics healthy when optional SQLite virtual/vector extension tables cannot be counted, while still reporting per-table count errors.

## 0.5.0

- Add database diagnostics in Settings with DB path, readability, file size, modified time, table count, and core table row counts.
- Add `/api/diagnostics` for install health checks and copyable diagnostics.
- Add unified session detail drawer showing related memories, triples, consolidations, and session timeline actions.
- Make top sessions, consolidation session actions, and timeline session chips open the unified session detail drawer.

## 0.4.4

- Auto-detect the standard Mnemosyne SQLite database path on first config creation, including common Mnemosyne environment variables.
- Show clearer Settings access URLs: `This Mac` for loopback access and `LAN` when binding to `0.0.0.0`.

## 0.4.3

- Add editable Settings fields for dashboard address/host, port, and Mnemosyne database location.
- Explain localhost (`127.0.0.1`) vs LAN (`0.0.0.0`) binding directly in the Settings UI.
- Allow the web Settings form to save host, port, and database path to plugin config, with restart guidance for changes to apply.

## 0.4.2

- Make the Mnemosyne brand mark/wordmark clickable on desktop and mobile so it returns to the Overview dashboard.

## 0.4.1

- Remove the Local only sidebar badge from desktop and mobile navigation to keep the sidebar/menu focused on product navigation.

## 0.4.0

- Simplify top-level navigation from nine tabs to five product sections: Overview, Explore, Activity, Graph, and Settings.
- Fold Search, Memories, and Recall Debugger into Explore with internal segmented tabs.
- Fold Timeline and Consolidations into Activity, and Triples into Graph.
- Add Overview quick actions so users can jump directly into common workflows without exposing every raw view in the sidebar.

## 0.3.12

- Hide the duplicate sidebar theme switch from the mobile hamburger menu now that theme control is available directly in the mobile top bar.

## 0.3.11

- Add a GitHub README screenshot gallery generated from synthetic mock Mnemosyne data across desktop, mobile, dark, and light theme views.
- Add a local screenshot generator script for refreshing the mock-data gallery without reading private memory data.

## 0.3.10

- Keep mobile timeline group event-count badges inside the card by letting long session headings wrap within the available width.

## 0.3.9

- Add extra mobile header spacing around the Great Vibes “M” mark so its glyph overhang does not overlap the Mnemosyne wordmark.

## 0.3.8

- Add a compact theme toggle directly to the mobile top bar so light/dark mode is available without opening the hamburger menu.

## 0.3.7

- Treat short phone-landscape viewports as compact mobile layout so the menu stays collapsed and desktop hero/sidebar content does not dominate the screen.
- Close the mobile menu automatically on resize/orientation changes.

## 0.3.6

- Change dashboard searches from broad substring matching to token-prefix matching so terms like "Dian" no longer match inside words such as "Obsidian".

## 0.3.5

- Rename the brand subtitle from "Memory OS" to "Memory for Hermes".

## 0.3.4

- Fix mobile stat-card number descenders being clipped in light theme by giving Playfair numerals extra line-height and bottom breathing room.

## 0.3.3

- Fix mobile overview stat labels being partially obscured by the stat-card glow layer and add extra label vertical breathing room.

## 0.3.2

- Refine mobile layouts for search, timeline, graph, consolidations, settings, overview cards, and memory cards.
- Keep mobile section headings and right-aligned helper labels within the viewport.
- Normalize mobile toolbar, result panel, and card widths to prevent horizontal overflow.
- Center the relationship graph canvas on mobile after rendering.
- Fix mobile password-auth checkbox sizing and spacing.

## 0.3.1

- Add `/api/health` smoke-test endpoint.
- Add baseline security headers (`Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`).
- Harden static file serving with path resolution against `static/`.
- Make numeric query parsing resilient to malformed limits/offsets.
- Add server-level pytest coverage for health, headers, bad query params, and static path escapes.
- Add project metadata and contributor guidance for GitHub publication.
- Run Ruff in GitHub Actions.

## 0.3.0

- Local read-only dashboard for Mnemosyne working/episodic memories, triples, graph, consolidations, search, recall debugging, timeline, theme switching, and optional password auth.
