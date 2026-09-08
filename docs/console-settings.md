# Console settings

Open **Settings → Edit settings** to change the factory name, provider catalog,
factory defaults, coordinator limits, product and pod assignments, approval
policies, and compatible models on existing execution routes.

Factory defaults include optional **Role assignments**. Add manager, builder,
reviewer, merge-captain, or any custom role; choose its configured provider ID,
optional model, and reasoning preference. One provider can fill several roles.
Roles inherit into products and pods unless overridden. They are saved planning
preferences, not new execution routes: they do not launch workers, grant merge
authority, or override an explicitly configured work-item execution plan.

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
