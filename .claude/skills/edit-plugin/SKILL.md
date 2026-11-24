---
name: edit-plugin
description: Edit and verify a Gestalts catalog plugin or its deck directly in this checkout.
---

Read the plugin's `plugin.yml`, source entry, and the relevant deck and gestalt definitions. Use the existing view and data APIs. Check the site distribution and keep the plugin's allowed permissions and pinned dependencies intact unless the requested change requires editing them.

Keep changes scoped to the selected plugin and any required catalog registration. Run `mise run publish-data <deck directory>` after editing deck data and `mise run gestalts:publish` when adding published definitions. Run `mise run check` and `mise run site:build`, summarize the diff, and leave visual checks to the user.
