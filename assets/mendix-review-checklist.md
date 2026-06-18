# Mendix Project Review Checklist

This file is used by AI agents to review a completed Mendix project. **Before performing a review, check `olc-config.json` in the project root.** If `IsKeepReviewChecklist` is `false`, do not perform the review.

When a developer requests a review, follow this checklist systematically against the `.mpr` model. Produce a structured review report at the end.

## How To Use

When asked to review, perform each section below by inspecting the `.mpr` SQLite database and project files. For each check, report one of:

- **PASS** — meets the standard.
- **WARN** — minor issue, recommend fixing.
- **FAIL** — violates the standard, must fix before release.
- **SKIP** — not applicable to this project.

At the end, produce a summary table and a list of actionable items.

---

## 1. Module Structure

Review module organization in the `.mpr` model.

- [ ] Each module has a clear, single responsibility.
- [ ] Module names use PascalCase with no abbreviations unless widely understood (e.g., OMS, HR).
- [ ] No orphaned or empty modules exist.
- [ ] Shared/reusable logic is in a dedicated utility or commons module, not duplicated.
- [ ] Module dependencies flow in one direction — no circular references between modules.

## 2. Domain Model

Inspect entities, attributes, and associations.

- [ ] Entity names are PascalCase, singular (e.g., `Order`, not `Orders`).
- [ ] Attribute names are PascalCase and descriptive (e.g., `StartDate`, not `SD`).
- [ ] Every entity has a clear owner module.
- [ ] Associations use descriptive names that reflect the relationship (e.g., `Order_Customer`).
- [ ] No unused entities or attributes remain in the model.
- [ ] Generalization/specialization hierarchies are justified and not overused.
- [ ] Calculated attributes are used only when necessary — prefer microflow expressions or computed values at retrieval time.

## 3. Microflow Quality

Decode and inspect microflow contents from the `.mpr` Unit table.

### Naming

- [ ] Microflows follow a consistent naming convention: `<Prefix>_<Entity>_<Action>` (e.g., `ACT_Order_Create`, `DS_Order_GetAll`, `SUB_Email_Send`).
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

Inspect page definitions and widget configurations from the `.mpr` model.

### Structure

- [ ] Page names follow a convention: `<Entity>_<Action>` (e.g., `Order_Overview`, `Order_NewEdit`).
- [ ] Pages have a clear layout: header, content area, and action bar are logically separated.
- [ ] Snippet usage is consistent — repeated UI patterns are extracted to snippets.
- [ ] No orphaned pages exist (pages not reachable from navigation or microflows).

### Widgets and Actions

- [ ] Every clickable widget (button, link, row action) has a clear caption or tooltip.
- [ ] DataGrid 2 configurations use appropriate pagination, not unlimited rows.
- [ ] Action buttons specify their action type explicitly (microflow, page, nanoflow).
- [ ] Double-click / default row actions are intentional and documented if they differ from the primary button action.
- [ ] Conditional visibility rules are clean — no conflicting or redundant conditions on the same widget.

### SCSS / Styling

- [ ] Custom styles use semantic class names (e.g., `.oms-decision-dropdown`), not Mendix-generated names (e.g., `.mx-name-textBox4`).
- [ ] No inline styles are used where a class would be reusable.
- [ ] SCSS files are organized per module or feature, not in one monolithic file.

## 5. Security

Inspect access rules, entity access, and page/microflow access.

- [ ] Every entity has access rules defined for each applicable user role.
- [ ] Access rules follow the principle of least privilege — no role has broader access than it needs.
- [ ] XPath constraints on entity access are present where data should be scoped per user/role.
- [ ] Pages are assigned to user roles — no pages are accessible to roles that should not see them.
- [ ] Microflows that perform sensitive operations (delete, commit, external calls) have role-based access restrictions.
- [ ] No entities are left with default (open) access rules.
- [ ] Sensitive attributes (passwords, tokens, personal data) are not exposed in overview pages or data grids without justification.

## 6. Navigation

Review navigation profiles and menu structures.

- [ ] Navigation items map to real, functional pages.
- [ ] Menu labels match the page content the user will see.
- [ ] No dead navigation entries (pointing to deleted or renamed pages).
- [ ] Navigation structure is logical — related items are grouped.
- [ ] Role-based navigation is configured — users only see menu items for their role.

## 7. Integration

If the project uses external services or APIs, review integration points.

- [ ] REST/SOAP service calls include error handling (HTTP status checks, timeout handling).
- [ ] Published services validate input and return appropriate error responses.
- [ ] Import/export mappings are up to date with the external schema.
- [ ] Credentials and endpoints are stored in constants or environment-specific configuration, not hardcoded.
- [ ] Published OData/REST services expose only the data that should be public.

## 8. Documentation and Knowledge Base

Review project documentation artifacts.

- [ ] `project-knowledge-base.md` exists and is up to date with recent changes.
- [ ] Key modules, entities, and microflows are documented in the knowledge base.
- [ ] Change log in the knowledge base has recent dated entries.
- [ ] Complex microflows have annotation activities explaining their purpose.

## 9. Git and Version Control

Review project files and version control hygiene.

- [ ] `.gitignore` includes all AI-generated and mxcli files.
- [ ] No large binary files or generated outputs are committed.
- [ ] Commit messages are descriptive and reference the task or ticket.

---

## Review Report Format

After completing the checklist, produce a report in the following format:

```markdown
# Mendix Project Review Report

**Project:** <project name>
**Reviewed:** <date>
**Reviewer:** AI Agent

## Summary

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

Any general observations, patterns noticed, or architectural recommendations.
```

Save the review report as `outputs/review-report-<date>.md` in the project root.
