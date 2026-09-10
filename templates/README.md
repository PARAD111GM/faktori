# Faktori templates

Templates are starting configurations you copy and customize, not installations
that silently change your factory. Keep your customized copies outside this
public repository. Each runnable template names its supported runner and the
approval needed to use it.

## Runnable workflows

| Template | What it runs | Requirements |
| --- | --- | --- |
| [Manager Loop](workflows/manager-loop/README.md) | AI Manager → fresh Implementer → verification → independent Reviewer → bounded repair → Manager acceptance, repeated by phase | Built Faktori, Node 24, authenticated Codex CLI, approved native test workspace |
| [Lean Loop](workflows/lean-loop/README.md) | Approved brief or existing candidate → verification → independent review → deterministic acceptance | Built Faktori, Node 24, authenticated configured provider, explicit scope approval |

Start with the template's README. Copy its configuration, replace placeholders,
review the intended effects, and run its documented command. There is no generic
`template install` command or plugin loader in this prototype.

## Document and provisioning templates

- `lifecycle/`: compact, normal, and high-risk artifact outlines.
- `provisioning/`: discovery, interview, and proposal records.

These are documents consumed by the corresponding skills, not executable
workflows. They do not grant approval or provision resources by themselves.

## Adding a workflow template

Use `workflows/<name>/` with a README and a configuration accepted by an existing
Faktori runner. Include prerequisites, exact run commands, placeholders, expected
outputs, cost/access implications, and failure/restart behavior. Default approval
flags to false, exclude credentials and personal paths, and explain what the
template does **not** support. Add its entry to the table above.
