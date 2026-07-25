# MCP and Skills Detail Dialog Design

## Goal

Open MCP and Skill details in a modal dialog from their catalog lists without navigating away from the list or changing the URL. Preserve the user's filters, workspace selection, and scroll position when the dialog closes.

## Scope

- Change card and explicit detail actions in `/dashboard/mcp` and `/dashboard/skills` to open dialogs.
- Keep the existing `/dashboard/mcp/[identifier]` and `/dashboard/skills/[slug]` routes working for direct links and bookmarks.
- Preserve detail actions such as install, uninstall, enable, configure credentials, test, and run where those actions are currently available.
- Compact MCP card actions without allowing install state to change the card height.
- Do not change backend contracts or catalog APIs.

## Approach

Use controlled dialogs owned by each catalog component. The selected catalog item is local state; selecting an item opens the dialog, and closing it clears the selection. The browser URL remains unchanged.

Extract reusable detail content from the existing detail pages where practical so the page and dialog share loading, rendering, and action behavior. The dialog supplies its selected identifier or catalog item directly, while the standalone page continues to derive the identifier from route parameters.

This is preferred over Next.js intercepted routes because intercepted routes update browser history and the URL. It is preferred over duplicating the detail markup because duplicated install and configuration flows would drift.

## Components

### Skills

- `SkillsGallery` owns the selected Skill catalog item.
- `SkillCard` receives an `onOpenDetails` callback instead of rendering detail links.
- A Skill detail dialog loads `getSkillCatalogDetail` using the gallery's resolved workspace and selected `catalogId`.
- The dialog shows the existing README and `SKILL.md` tabs, metadata, and install state.
- Successful install or uninstall updates both the dialog and catalog card state and invokes the existing catalog-change callback.

### MCP

- `McpMarket` owns the selected MCP identifier.
- `McpCard` receives an `onOpenDetails` callback instead of rendering a detail link.
- An MCP detail dialog loads `getWorkspaceMarketMcp` using the current workspace and selected identifier.
- The dialog retains the current detail information and MCP actions, including credentials configuration.
- Successful mutations update the catalog item so the card reflects the latest install state after the dialog closes.

### MCP Card Layout

- MCP cards use a stable height and a fixed-height footer in both installed and uninstalled states. Installing or uninstalling a server must not resize the card or its grid row.
- The installed footer is one compact horizontal action row. It contains a truncated connection/tool status, icon buttons for test, settings, and uninstall, and the enabled switch. Each icon-only action has an accessible label and tooltip.
- The uninstalled footer occupies the same fixed-height region and contains the install action.
- Source links are removed from the card body and rendered as an icon button in the card's top-right header area. A GitHub URL uses the Lucide GitHub icon; another source host uses the external-link icon.
- Source icon clicks open the source in a new tab and do not open the detail dialog.
- The header preserves space for the source icon and installed badge so long titles truncate without overlapping either control.

### Standalone Detail Routes

The existing detail routes remain available. Shared detail content accepts an explicit workspace and identifier/catalog item, allowing route pages to retain their current direct-entry behavior without coupling the catalog dialog to routing.

## Interaction

- Clicking the card's detail surface or explicit Details control opens the dialog.
- Install, run, toggle, test, configure, and uninstall controls do not accidentally open or close the detail dialog.
- MCP source icon buttons do not open the detail dialog.
- The dialog closes through its close button, Escape, or overlay click when no nested confirmation or credentials dialog is active.
- Focus moves into the dialog on open and returns to the triggering control on close through the existing Radix-based Dialog primitive.
- The dialog is constrained to the viewport and scrolls its body independently on desktop and mobile.
- Opening and closing a detail dialog does not change the URL.

## Loading and Errors

- Show a stable loading state while fetching details.
- Ignore stale responses when the selected item, workspace, or dialog state changes.
- Render an inline retryable error state when detail loading fails; do not silently substitute catalog summary data for a failed detail response.
- Existing action errors continue to use toast notifications.

## Verification

- Component-level tests verify card clicks open the correct dialog and do not invoke router navigation.
- Tests verify closing restores the catalog, action buttons do not trigger the detail opener, and stale detail responses are ignored.
- Tests verify Skill install state and MCP install/configuration state are reflected in both dialog and card after mutations.
- Tests verify MCP cards retain the same dimensions when their install state changes and installed controls remain on one row at supported widths.
- Tests verify GitHub sources use the GitHub icon in the card header and source clicks do not open the detail dialog.
- Run the web package typecheck/lint and focused tests.
- Use a real browser at desktop and mobile viewport sizes to verify dialog sizing, scrolling, focus/keyboard closure, nested credential dialogs, and unchanged URL behavior.
