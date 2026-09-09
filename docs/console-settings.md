# Console settings

Open **Settings → Edit settings** to change the factory name, provider catalog,
factory defaults, coordinator limits, product and pod assignments, approval
policies, and compatible models on existing execution routes.

Factory defaults include optional **Role assignments**. Add manager, builder,
reviewer, merge-captain, or any custom role; choose its configured provider ID,
optional model, and reasoning preference. One provider can fill several roles.
Roles inherit into products and pods unless overridden. At the start of new
work, the coordinator applies the matching role's provider, model and reasoning
before recording the admitted run. Work without an explicit role uses `builder`
when that assignment exists; otherwise its existing execution plan is preserved.
Setting a role does not start work or grant merge, deployment, or policy authority.

An owner-configured work item's `intent.workItem.role` selects a named role,
including custom roles. Explicit roles require a matching assignment in the
resolved product/pod scope. A scope's role list replaces its inherited list;
an explicit empty list removes inherited assignments.

The provider ID resolves through the provider catalog to an existing execution
route. The work item's execution profile does not change: an isolated job never
silently switches to native execution. A role's model overrides the plan's model;
leaving it blank keeps the plan's model, which must be compatible with the selected
provider. Unsupported routes or settings block the launch before admission.
Leaving reasoning blank retains the work plan's setting, or the provider default
when the plan has none.
Codex and Claude support explicit reasoning; the current Cursor ACP transport
does not support explicit role model/reasoning overrides and rejects them rather
than ignoring them. Provider authentication and model access remain prerequisites.

Admitted runs retain their recorded assignment. Explicit session resumes are not
rerouted into a different provider's session. Roles select who performs already
configured work; they do not generate a manager/build/review pipeline merely by
being added to Settings.

Factory GM diagnosis can opt into a named role through its diagnosis template's
`intent.workItem.role`. It does not inherit the product Builder role implicitly,
and assigning a product Manager does not turn it into the Factory GM.

1. Edit the fields you need. Expanding a section does not change it.
2. Choose **Review changes**. The service validates the proposed configuration
   against the current file and displays changes and material risks.
3. Acknowledge each listed risk, then choose **Confirm & save**.
4. Restart the Console with the same configuration file to apply the saved
   configuration. Saving does not reconfigure or interrupt running workers.

The page identifies saved changes awaiting restart. Its provider cards and
configuration summaries continue to describe the loaded configuration; reopen
the editor to inspect the saved configuration. If another editor changes the
file, a stale save is rejected rather than overwriting their work.

Editing requires the local command token and a Console started from an
owner-controlled configuration file. Secrets, provider environments, credential
profiles, runtime commands, and storage paths are not editable in the browser.
Those fields are preserved when saving.

Adding a provider to the catalog does not install its CLI, authenticate it, or
create an execution route. Those setup operations still belong to the bootstrap
agent and provider-owned login flow. Models listed here are configured route
compatibility settings, not claims about account access or authenticated usage.

Changes to factory defaults retain the existing inheritance structure. Existing
explicit product or pod overrides still take precedence. Coordinator limits
remain separate from scoped budgets; both need to accommodate intended work.
