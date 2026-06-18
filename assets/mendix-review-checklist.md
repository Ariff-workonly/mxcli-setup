# Mendix Project Review Checklist

This file is used by AI agents to review changes on the current branch of a Mendix project. **Before performing a review, check `olc-config.json` in the project root.** If `IsKeepReviewChecklist` is `false`, do not perform the review.

## How To Use

### Step 1: Identify What Changed

Before reviewing anything, determine the **base branch** and compare changes:

1. Run `git log --oneline main..HEAD` (or the appropriate base branch) to see all commits on this branch.
2. Run `git diff main..HEAD --name-only` to list changed files.
3. For the `.mpr` model, use mxcli to inspect changes:
   - `./mxcli -p app.mpr -c "SHOW STRUCTURE"` to understand the current state.
   - Cross-reference with the git diff to identify which modules, entities, microflows, pages, and other artifacts were added or modified.
4. If a `diff-local` or `diff-script` command is available, use it to get a detailed model diff.

**Only review the changed artifacts.** Do not review unchanged parts of the project.

### Step 2: Review Changes Against Checklist

For each changed artifact, apply the relevant checks from the sections below. For each check, report one of:

- **PASS** — meets the standard.
- **WARN** — minor issue, recommend fixing.
- **FAIL** — violates the standard, must fix before release.
- **SKIP** — not applicable to this change.

### Step 3: Produce Report

At the end, produce a summary table and a list of actionable items.

---

## 1. Module Structure

Apply only if modules were **added or reorganized** in this branch.

- [ ] New modules have a clear, single responsibility.
- [ ] Module names use PascalCase with no abbreviations unless widely understood (e.g., OMS, HR).
- [ ] No orphaned or empty modules were introduced.
- [ ] Shared/reusable logic is in a dedicated utility or commons module, not duplicated.
- [ ] New module dependencies do not introduce circular references.

## 2. Domain Model

Apply only to entities, attributes, and associations that were **added or modified**.

- [ ] New entity names are PascalCase, singular (e.g., `Order`, not `Orders`).
- [ ] New attribute names are PascalCase and descriptive (e.g., `StartDate`, not `SD`).
- [ ] New entities have a clear owner module.
- [ ] New associations use descriptive names that reflect the relationship (e.g., `Order_Customer`).
- [ ] No unused entities or attributes were introduced.
- [ ] Generalization/specialization is justified if introduced.
- [ ] Calculated attributes are used only when necessary.

## 3. Microflow Quality

Apply only to microflows that were **added or modified**.

### Naming

- [ ] New microflows follow a consistent naming convention: `<Prefix>_<Entity>_<Action>` (e.g., `ACT_Order_Create`, `DS_Order_GetAll`, `SUB_Email_Send`).
- [ ] Common prefixes are used consistently: `ACT` (action), `DS` (data source), `SUB` (sub-microflow), `VAL` (validation), `SE` (scheduled event), `BCO` (before commit), `ACO` (after commit), `BDE` (before delete), `ADE` (after delete).
- [ ] No generic names like `Microflow1`, `Sub_DoStuff`, or `Untitled`.

### Logic

- [ ] Retrieve activities specify whether they retrieve from the database or from cache, with a justified choice.
- [ ] Retrieves with `SingleObject = true` include a sort order.
- [ ] Retrieves use association-based paths over XPath string matching when a direct association exists.
- [ ] Empty object checks exist before using retrieved objects.
- [ ] No unused parameters in microflow signatures.
- [ ] Error handling is present: exclusive splits handle edge cases, and error flows exist for critical paths.
- [ ] Long microflows (more than 15 activities) are broken into sub-microflows with clear names.
- [ ] Commit actions are minimized — batch commits where possible, avoid committing inside loops.
- [ ] Delete actions include confirmation or are guarded by validation logic.

### Performance

- [ ] No retrieves inside loops — use batch retrieval before the loop.
- [ ] List operations (filter, find, sort) are preferred over repeated database calls.
- [ ] Scheduled events do not run expensive queries without pagination or batching.

## 4. Page and UI Quality

Apply only to pages and snippets that were **added or modified**.

### Structure

- [ ] New page names follow a convention: `<Entity>_<Action>` (e.g., `Order_Overview`, `Order_NewEdit`).
- [ ] Pages have a clear layout: header, content area, and action bar are logically separated.
- [ ] Repeated UI patterns are extracted to snippets.
- [ ] New pages are reachable from navigation or microflows (not orphaned).

### Widgets and Actions

- [ ] Every clickable widget (button, link, row action) has a clear caption or tooltip.
- [ ] DataGrid 2 configurations use appropriate pagination, not unlimited rows.
- [ ] Action buttons specify their action type explicitly (microflow, page, nanoflow).
- [ ] Double-click / default row actions are intentional and documented if they differ from the primary button action.
- [ ] Conditional visibility rules are clean — no conflicting or redundant conditions on the same widget.

### SCSS / Styling

- [ ] New custom styles use semantic class names (e.g., `.oms-decision-dropdown`), not Mendix-generated names (e.g., `.mx-name-textBox4`).
- [ ] No inline styles are used where a class would be reusable.

## 5. Security

Apply only to access rules and security settings that were **added or modified**.

- [ ] New entities have access rules defined for each applicable user role.
- [ ] Access rules follow the principle of least privilege — no role has broader access than it needs.
- [ ] XPath constraints on entity access are present where data should be scoped per user/role.
- [ ] New pages are assigned to the correct user roles.
- [ ] New microflows that perform sensitive operations (delete, commit, external calls) have role-based access restrictions.
- [ ] No new entities are left with default (open) access rules.
- [ ] Sensitive attributes (passwords, tokens, personal data) are not exposed in overview pages or data grids without justification.

## 6. Navigation

Apply only if navigation entries were **added or modified**.

- [ ] New navigation items map to real, functional pages.
- [ ] Menu labels match the page content the user will see.
- [ ] No dead navigation entries were introduced.
- [ ] New items are logically grouped with related entries.
- [ ] Role-based navigation is configured for new items.

## 7. Integration

Apply only if integration points were **added or modified**.

- [ ] New REST/SOAP service calls include error handling (HTTP status checks, timeout handling).
- [ ] New published services validate input and return appropriate error responses.
- [ ] Import/export mappings are up to date with the external schema.
- [ ] Credentials and endpoints are stored in constants or environment-specific configuration, not hardcoded.
- [ ] New published OData/REST services expose only the data that should be public.

## 8. Documentation

Apply to documentation changes and completeness for the changed artifacts.

- [ ] New or modified modules, entities, and microflows are documented in the knowledge base (if enabled).
- [ ] Complex new microflows have annotation activities explaining their purpose.

## 9. Git and Version Control

Review the branch's commit and file hygiene.

- [ ] `.gitignore` includes any new AI-generated or mxcli files.
- [ ] No large binary files or generated outputs are committed on this branch.
- [ ] Commit messages are descriptive and reference the task or ticket.
- [ ] No unrelated changes are bundled into this branch.

---

## Review Report Format

After completing the checklist, produce a report in the following format:

```markdown
# Mendix Branch Review Report

**Project:** <project name>
**Branch:** <branch name>
**Base branch:** <base branch>
**Reviewed:** <date>
**Reviewer:** AI Agent

## Changes Summary

Brief description of what this branch introduces (features, fixes, refactors).

### Changed Artifacts

| Type | Name | Change |
|---|---|---|
| Entity | Module.EntityName | Added / Modified |
| Microflow | Module.MicroflowName | Added / Modified |
| Page | Module.PageName | Added / Modified |
| ... | ... | ... |

## Review Results

| Category | Pass | Warn | Fail | Skip |
|---|---|---|---|---|
| Module Structure | | | | |
| Domain Model | | | | |
| Microflow Quality | | | | |
| Page and UI Quality | | | | |
| Security | | | | |
| Navigation | | | | |
| Integration | | | | |
| Documentation | | | | |
| Git and Version Control | | | | |

## Findings

### FAIL Items (Must Fix)

1. **[Category]** Description of the issue. Affected artifact: `<name>`. Recommendation: ...

### WARN Items (Should Fix)

1. **[Category]** Description of the issue. Affected artifact: `<name>`. Recommendation: ...

### Observations

Any general observations, patterns noticed, or recommendations for the branch.
```

Save the review report as `outputs/review-report-<branch>-<date>.md` in the project root.
