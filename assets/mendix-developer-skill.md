# Mendix Developer Skill

This file is used for AI agent to carry out development or analysis task in Mendix project. Everytime any task to be executed in the Mendix project, please refer to this file. 

## Mendix Model Inspection Guardrail

When analyzing Mendix pages, never rely only on rendered HTML or text search. Decode the `.mpr` Unit contents and recursively inspect page/snippet widgets, especially nested DataGrid 2 `CustomWidgets$CustomWidget` properties, to find actual actions and target microflows/pages.

## Project Search Workflow

Always inspect the `.mpr` model, not only project files.

Plain text search with `rg` often misses Mendix pages, captions, widget actions, and microflows because they are stored inside the `.mpr` database. Search both:

1. Normal files with `rg`.
2. The `.mpr` SQLite `Unit` table by decoding `Contents`.

Search by exact phrase first, then variants. For requirement text like `Reference Documents Review`, search:

```text
Reference Documents Review
Reference Document Approval
ReferenceDocuments
ReferenceDocumentApproval
ApprovalOverview
```

## Map Labels To Mendix Artifacts

When a user-facing label is found, identify:

1. Module name.
2. Page or snippet name.
3. Menu/navigation entry.
4. Data source microflow.
5. Action microflow or page target.
6. Related entity.

Example output:

```text
Reference Document Approval menu opens OMS.ReferenceDocuments_ApprovalOverview, whose header is Reference Documents Review.
```

For requirement matching, keep a known-alias mapping table as analysis proceeds:

| User label | Technical artifact |
| --- | --- |
| OMS Tasks | `OMSHomepage.Home_OMS` / `SNP_OMSHome_OMSTask` |
| Notification Centre | `OMSHomepage.Home_OMS` / `notificationcenterdatagrid` |
| Reference Documents Review | `OMS.ReferenceDocuments_ApprovalOverview` |
| Activity Forms Table View | `ActivityFormManagement.ActivityForm_Overview` |
| Daily Morning Meeting Table View | `MeetingManagement.MeetingRecords_Overview_DailyRecords` |

## Page And Action Tracing

For page/action analysis, trace clickable widgets. Do not stop at DOM or page name. For each relevant page/grid, inspect:

1. `Forms$ActionButton`
2. `Forms$MicroflowAction`
3. `Forms$FormAction`
4. `OnClickAction`
5. `OnDoubleClickAction`
6. Widget `DefaultAction`
7. Nested widgets inside DataGrid 2 custom widgets

For DataGrid 2, inspect nested widget properties. Mendix DataGrid 2 appears as `CustomWidgets$CustomWidget`, and buttons are often nested deep inside `Object.Properties[*].Value.Objects[*]...Widgets`. Recursively scan nested widgets for `Forms$ActionButton`.

Distinguish row actions from button/link actions. Report clearly whether the action is:

1. Row double-click/default action.
2. Hyperlink/action button inside a column.
3. Toolbar button.
4. Bulk selection button.

This matters because a requirement may say "double-click line" while the implementation only has a link or button.

## Microflow Trace Requirements

Trace called microflows until the final page. If a button calls a microflow, inspect the microflow for:

1. Retrieve source.
2. XPath constraints.
3. Selected object.
4. Empty checks.
5. `ShowFormAction`.
6. Final page opened.
7. Parameter mappings.

Flag unsafe retrieve patterns as risks:

1. `SingleObject = true` without sort.
2. Retrieving by non-unique fields like `LotNo + ProductionLine`.
3. No empty check before using a retrieved object.
4. Assuming child records share the same parent/order.
5. Unused parameters.
6. Opening the first matching Record Sheet instead of the exact linked one.

Prefer association-based retrieval over string matching whenever possible.

Example:

```text
Instead of finding Record Sheet by LotNo + StringProductionLine, prefer a direct association to ProductionOrder, Batch, OMSRecordSheet, or OMSRSUnitProcess.
```

## Navigation Review Trace Format

When reviewing navigation requirements, build a small trace:

```text
User label:
Menu item:
Page:
Grid/snippet:
Clickable widget:
Action:
Microflow logic:
Final opened page:
Risk:
Recommendation:
```

## Generated Analysis Reports

Keep generated analysis reports for repetitive scanning. Prefer CSV or Markdown reports listing:

1. Page.
2. Grid name.
3. Entity/data source.
4. Buttons.
5. Button caption.
6. Action type.
7. Target page/microflow.
8. Whether it opens Record Sheet.

## UI/UX and SCSS Guardrails

When making UI/UX or CSS styling changes in Mendix, especially in `.scss` files, do not target generated Mendix element names directly for new styles.

Avoid hardcoding selectors such as:

```scss
.mx-name-dropDown5 { ... }
.mx-name-textBox4 { ... }
.mx-name-comboBox9 { ... }
```

Instead, create a semantic CSS class name and apply that class to the relevant Mendix widget or container in Studio Pro.

Preferred pattern:

```scss
.oms-decision-dropdown {
  // styles here
}
```

When adding a new style, document:

1. The CSS class name.
2. The widget or element where the class should be applied.
3. The purpose of the class.

Example:

```text
Class name: oms-decision-dropdown
Apply to: the Dynamic Yes/No decision dropdown widget
Purpose: align decision dropdown spacing and sizing in the record sheet action row
```

Existing legacy styles that already target `.mx-name-*` selectors should not be expanded unless the task is specifically to clean up or migrate them.

## Project Knowledge Base

**Before reading or updating the knowledge base, check `olc-config.json` in the project root.** If `IsKeepKnowledgebase` is `false`, skip all knowledge base operations entirely.

A tiered knowledge base exists for this project:

- `project-knowledge-base.md` — Summary index (read every session). Keep under 200 lines.
- `knowledge-base/modules.md` — Module details.
- `knowledge-base/entities.md` — Entity relationships.
- `knowledge-base/microflows.md` — Microflow traces.
- `knowledge-base/business-flow.md` — Business logic and process flows.
- `knowledge-base/archive.md` — Old/resolved entries.

Rules:

1. Always read `project-knowledge-base.md` at the start of every session.
2. Only load detail files when working on that specific area.
3. Write new findings to the appropriate detail file, not the index.
4. Update the index only with brief summaries and pointers.
5. When the index exceeds 200 lines, compress or move entries to detail files.
6. Move outdated entries to `knowledge-base/archive.md` instead of deleting.

## Git ignore

Whenever AI or mxcli generated any files in the project directory, make sure the files to be included in git ignore file of the Mendix project.
