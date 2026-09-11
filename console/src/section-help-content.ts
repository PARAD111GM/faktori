export type SectionHelp = {
  summary: string;
  source: string;
  next: string;
  note?: string;
};

const help = (summary: string, source: string, next: string, note?: string): SectionHelp => ({ summary, source, next, note });

const sections: Record<string, SectionHelp> = {
  'at a glance': help(
    'A quick count across saved project plans: open decisions, blocked tickets, and whether the numbers may be old. It is not live activity.',
    'Saved project plans and the latest Console snapshot; counts can be missing or old.',
    'Open Decisions for a pending owner choice, or Work to inspect the ticket behind a count.',
    'A tidy ledger is useful. It is not proof the machines are running.',
  ),
  'factory signal': help(
    'Separates factory operations from product-delivery problems so a blocked release is not quietly painted as a broken factory.',
    'Factory GM snapshot and saved project-plan status; neither is a live provider-health check.',
    'Open Factory to inspect the finding, its owner, and the recorded next action.',
  ),
  'project rollups': help(
    'A project-by-project view of tickets with saved status. Review, merge, deployment, and product acceptance are different steps.',
    'Saved project plans only; a missing status stays missing rather than guessed.',
    'Open the project to read its ordered plan and its evidence annotations.',
  ),
  'decision inbox': help(
    'The queue for observed problems that need an owner response or delegation. A recorded response is not Manager acknowledgement or resolution.',
    'Saved decision records; they can be old or missing.',
    'Open the decision, review its evidence, then make the requested decision.',
  ),
  manager: help(
    'The optional Manager connection recorded for this factory. Its last contact is a timestamp, not a liveness check or an authority delegation.',
    'Manager-connected configuration and latest published contact record.',
    'Use Work to inspect recorded sessions or configure the Manager through the owner-controlled setup.',
  ),
  'assigned sessions': help(
    'Sessions assigned to saved project-plan work. They show role and scope, while provider, capability, and live activity can remain unknown.',
    'Saved session records and optional Manager details.',
    'Match the scope to the work item, then inspect its project, request, or run.',
  ),
  'jira work': help(
    'A read-only mirror of configured Jira issues, grouped by Jira status. Changes happen in Jira, not by moving cards here.',
    'Latest successful Jira sync for the selected scope; stale and truncated boards may omit current work.',
    'Open the issue in Jira to update it, or open a linked coordinator run for execution evidence.',
  ),
  'running activity': help(
    'Recent saved events from runs, loops, requests, decisions, and Jira. It is a digest, not a live agent transcript.',
    'Saved summaries from the coordinator and connected sources; only the shown scope and time window are included.',
    'Filter by source, then open the linked run, loop, request, or decision for the underlying record.',
  ),
  'manager-connected work': help(
    'An experimental handoff area for a separately configured active Manager. It can queue a request, but does not find tasks or prove delivery.',
    'Saved Manager sessions, contact records, and request summaries; contact time is not proof the Manager is active.',
    'Select a saved session, give a clear instruction, and inspect the resulting request.',
  ),
  'recorded sessions': help(
    'Sessions the connected Manager saved for inspection or request routing. They show identity and scope, not live availability.',
    'The active Manager snapshot; omitted or old sessions are not inferred.',
    'Choose a listed alias only when it matches the work scope you intend to request.',
  ),
  'enqueue work': help(
    'Creates one clear Manager request for a saved session. The form keeps the same request ID for a manual retry if the result is uncertain.',
    'Your chosen session, instruction, and—when enabled—the current project-plan version; it grants no extra authority.',
    'Name the work, give a scoped instruction, submit once, then inspect Requests for the recorded status.',
  ),
  requests: help(
    'Recorded Manager-connected request summaries and statuses. A Manager-reported accomplishment is not independent product acceptance.',
    'Manager request records and their published reports; it may lag or omit native provider detail.',
    'Open the related request or run and follow the stated next gate rather than treating a report as shipment.',
  ),
  'start approved work': help(
    'Starts a work item only when the coordinator finds it eligible under the currently loaded policy and admission state.',
    'Coordinator admission checks and the entered work-item ID; the button does not create approval or widen permissions.',
    'Enter the exact approved work ID, then inspect the created run and any admission blocker.',
  ),
  'manager loops': help(
    'Read-only history of Manager-run phases, reviews, repairs, and delivery gates. “Locally accepted” is one milestone, not deployment.',
    'Loop-runner records and published delivery evidence; a stale record does not prove a worker is alive.',
    'Open the original record for the next required step or use Work to inspect related activity.',
  ),
  hierarchy: help(
    'The saved parent-child structure for factory, product, plan, phase, and ticket work in the selected scope.',
    'Saved parent-child links from the coordinator; hidden or unlinked work is not invented.',
    'Select the appropriate project or pod filter, then inspect the related plan or ticket.',
  ),
  dependencies: help(
    'Saved “depends on” links between work items. It shows known constraints, not a prediction that scheduling will resolve them.',
    'Saved coordinator dependency links for the active scope.',
    'Open the blocking work and resolve or record the dependency through the normal project path.',
  ),
  timeline: help(
    'A durable sequence of recorded admission, owner instructions, and provider outcomes for this run.',
    'Coordinator records; timestamps and summaries can be absent, and an event is not proof that every effect completed.',
    'Open the original run record or inspect Evidence before relying on a run outcome.',
  ),
  execution: help(
    'The run’s observed provider, model, execution profile, and authority epoch. It describes the run envelope, not a permission grant.',
    'Coordinator run metadata; unobserved values remain deliberately unfilled.',
    'Use the original run record to check its identity and current authority before any consequential follow-up.',
  ),
  evidence: help(
    'Saved checks attached to this run or decision. Read them in context; they do not automatically mean the work is accepted.',
    'Run result records and linked files, limited to what the coordinator can safely show.',
    'Open the original record and check which acceptance or release step the evidence supports.',
  ),
  'provider requests': help(
    'Questions, permission prompts, or plan responses a provider has explicitly surfaced for this run. Faktori does not invent missing provider controls.',
    'Pending provider-request records from the run; unsupported provider capabilities are absent.',
    'Read the prompt, send only the answer you authorize, then wait for the next saved provider turn.',
  ),
  'admission blockers': help(
    'Read-only coordinator diagnoses explaining why work cannot be admitted or resumed safely.',
    'Coordinator blocker records, including safe ownership paths and overlap information; they do not repair or release work.',
    'Follow the named remediation with the accountable owner, then retry only when the blocker is resolved.',
  ),
  'general manager supervision': help(
    'Shows the configured daily GM review schedule and its latest recorded evaluation. Configuration alone is not monitoring proof.',
    'GM scheduler and review snapshot; an overdue or failed evaluation is shown as degraded rather than assumed healthy.',
    'Inspect the latest review or correct the scheduler/configuration through the owner-controlled factory setup.',
  ),
  'latest gm review': help(
    'Read-only recommendations from the last successful consolidated GM review. They are proposals, not approvals or applied changes.',
    'The latest retained GM review result and its cited evidence.',
    'Choose a proposal worth pursuing and send it through the normal approved delivery path.',
  ),
  'read-only preflight': help(
    'A check tied to one saved revision of the Console data and execution prerequisites. It does not admit work, repair the factory, or launch a provider.',
    'Read-only local preflight checks; a working configuration does not prove live execution.',
    'Address the listed remediation, then obtain the appropriate admission or execution evidence separately.',
  ),
  'resource signals': help(
    'Known usage, reservations, reported measurements, and unknown telemetry kept separate so estimates do not become pretend spending facts.',
    'Coordinator resource records and provider-reported measurements; unavailable values stay unavailable.',
    'Inspect the affected run or capacity policy before changing limits or drawing a cost conclusion.',
  ),
  'queue age': help(
    'How long currently visible runs have waited in the queue. It distinguishes human wait from evidence of actual execution.',
    'Observed queued run records in the current scope.',
    'Open an aged run to find its admission state, blocker, or pending owner action.',
  ),
  'qualified delivery efficiency': help(
    'Measured delivery-efficiency signals with stated cohort and qualification rules. Unknown telemetry stays outside the arithmetic.',
    'Saved GM efficiency summary and its source coverage; it is analysis, not a cost ceiling.',
    'Read the qualification note, then inspect the underlying sources before acting on a trend.',
  ),
  'infrastructure health': help(
    'Operational factory findings only. Product delivery blockers are deliberately kept elsewhere so the boiler room does not swallow the build plan.',
    'Unresolved GM findings classified as infrastructure; absence does not prove a model review ran.',
    'Open the supporting record and complete the accountable owner’s next action.',
  ),
  'product-delivery blockers': help(
    'Linked delivery work that is holding a product outcome. These are not automatically factory-health failures.',
    'Unresolved GM findings classified as delivery blockers.',
    'Open the linked Work, Settings, or supporting record and resolve the stated dependency.',
  ),
  'gm improvement backlog': help(
    'Read-only improvement proposals from the GM. Unapproved ideas stay ideas; no foreman has secretly requisitioned a new conveyor.',
    'Published GM proposal records and their authority annotations.',
    'Choose a proposal, obtain the required approval, and create normal scoped delivery work.',
  ),
  'qualified progress': help(
    'Saved ticket status and separately labelled evidence counts. Acceptance, review, merge, deployment, and product acceptance are different things.',
    'The project’s saved plan file and owner-added evidence notes; missing data is not guessed.',
    'Open the plan and ticket records to verify the particular gate you care about.',
  ),
  'daily summary': help(
    'A retained local-day summary of recorded changes and current explicit ticket statuses. Same-day activity does not alter acceptance.',
    'The project plan’s saved event history; PR history can be missing or incomplete.',
    'Open the project plan or linked work item for the records behind a count.',
  ),
  'linked pull requests': help(
    'Read-only PR observations linked to saved tickets. A merge is not ticket acceptance, and GitHub review status is not an independent Faktori review gate.',
    'Explicit PR links and their last observed provider state.',
    'Open the PR for its current provider status, then verify the separate acceptance and deployment gates.',
  ),
  artifacts: help(
    'Published project artifacts such as plans, specifications, or reports. An owner snapshot is a recorded copy, not a live file read.',
    'The saved project-plan artifact record, including source revision and freshness when supplied.',
    'Read the artifact basis and revision before using it as current implementation guidance.',
  ),
  'provider catalog': help(
    'The providers this factory configuration may reference. Adding a name here does not install a CLI, authenticate, or create an execution route.',
    'Editable factory configuration, not a test of provider availability or login.',
    'Configure the provider route and complete provider-owned authentication outside this Console before requesting execution.',
  ),
  'compatible models': help(
    'Model names declared for an existing execution route. They are compatibility metadata, not proof a model is available or permitted now.',
    'Saved configuration for configured provider routes.',
    'Verify the provider route and its current capabilities before selecting or relying on a model.',
  ),
  'factory defaults': help(
    'The inherited provider, environment, profile, limits, and authority policy used unless a product or pod overrides them.',
    'Currently loaded factory configuration; saved edits may require a Console restart before they apply.',
    'Inspect product and pod overrides, then use Edit settings to propose a reviewed configuration change.',
  ),
  'resources & limits': help(
    'Coordinator limits loaded by this service. Limits control admission; they are neither live usage measurements nor subscription balances.',
    'Currently running factory configuration and coordinator settings.',
    'Review the consequence of a change in settings, then save and restart only when authorized.',
  ),
  'environments & maintenance': help(
    'Configured environments, routine maintenance, and GM scheduling. A configured recovery action does not imply rollback is enabled or healthy.',
    'Loaded factory configuration; scheduler installation and health are observed separately.',
    'Inspect the relevant setting or preflight result before depending on an environment or maintenance action.',
  ),
  'products & pod configuration': help(
    'Resolved product and pod assignments, including inherited policies. It describes configured scope, not work already verified or deployed.',
    'Loaded factory configuration and its resolved overrides.',
    'Expand the product or pod, then review the exact provider, environment, limits, and authority before starting work.',
  ),
  'apply saved changes': help(
    'Explains what a saved configuration change still needs before it affects the running Console or workers.',
    'Saved local configuration versus the currently loaded service state.',
    'Restart the Console from the same owner-controlled configuration, then verify the loaded values.',
  ),
  'console connection': help(
    'The browser-session local command token used to authorize Console actions. It is not a provider login or a broader factory permission.',
    'A token kept only in this browser session; the Console never displays or stores provider credentials here.',
    'Use a valid local command token only when you are authorized to submit the intended action.',
  ),
  'catalog unavailable': help(
    'Projects needs its saved project-plan index: the optional workCatalog file of projects, plans, phases, and tickets. This is not the provider catalog.',
    'The Console configuration has no readable workCatalog.path, or that file could not be loaded.',
    'Ask your agent to set workCatalog.path to the existing owner-controlled catalog JSON file, then reload; restart only this Console if its startup settings changed, when safe.',
  ),
  'no projects published': help(
    'The saved project-plan index has no projects to show. It does not mean provider configuration is missing.',
    'The current workCatalog file, which may be empty, old, or filtered by configuration.',
    'Inspect the owner-maintained workCatalog entries; valid file edits reload automatically.',
  ),
  'configure your factory': help(
    'The staged editor for owner-controlled factory configuration: edit, review consequences, then confirm and save. Saving changes configuration, not running workers.',
    'Editable local factory configuration and server-side validation; changes may wait for a Console restart.',
    'Make a narrow change, review every listed consequence, confirm only if authorized, then restart when required.',
  ),
  'review changes': help(
    'The final comparison of your draft with the loaded configuration, including consequences that require acknowledgement.',
    'Server-side preview validation of the draft; valid configuration is not proof of live provider readiness.',
    'Read each change and risk, acknowledge only understood consequences, then confirm and save if authorized.',
  ),
  limits: help(
    'Limits for this factory, product, or pod. They can stop work from starting, but they do not show actual use or money spent.',
    'Saved settings in the current draft or loaded configuration.',
    'Read the effect of each limit, then change it only through a reviewed, authorized settings update.',
  ),
  'approval & deployment policy': help(
    'Saved rules for who must approve work and what may be released. Rules do not prove a review, merge, or deployment happened.',
    'Saved settings in the current draft or loaded configuration.',
    'Check the rule for the next step, then use the normal approval or release path.',
  ),
  'required capabilities': help(
    'Abilities a work route must have, such as isolated execution or a token limit. A checked box does not prove the route works today.',
    'Saved route requirements in the current draft or loaded configuration.',
    'Verify the selected route separately before asking it to run work.',
  ),
  'coordinator limits': help(
    'Factory-wide limits the coordinator uses when deciding whether work may start. They are separate from product defaults.',
    'Saved coordinator settings in the current draft.',
    'Change these only when you understand which work may be delayed or refused.',
  ),
  'declared capabilities': help(
    'What the settings say a provider route can do. It is a list of intended support, not a live provider test.',
    'Loaded provider-route settings.',
    'Check the provider’s actual route and current login before relying on a capability.',
  ),
  'what the configuration must contain': help(
    'The minimum saved factory settings needed to show and edit this Console’s configuration. It must match this factory and must not include credentials.',
    'The owner-controlled local Console configuration file.',
    'Ask your agent to add the approved factoryConfiguration for this factory, then reload or restart this Console when safe.',
  ),
  'technical details for your agent': help(
    'The exact local error saved by the Console to help your coding agent fix the connection. It does not change source files.',
    'The latest workCatalog load error.',
    'Give this detail to your agent so it can check the workCatalog path or file contents.',
  ),
  'phase and review history': help(
    'Past phase, review, and repair entries for this Manager loop. A completed phase or local acceptance does not by itself mean deployed.',
    'Saved loop history; an old record does not show whether a worker is still active.',
    'Use the delivery gates and next required action to see what still needs to happen.',
  ),
  overview: help('The high-level view of saved plan counts, decisions, and factory signals. It is a quick orientation, not live factory activity.', 'Latest local Console snapshots from saved plans and factory records.', 'Open the named project, decision, Work, or Factory view for the underlying record.'),
  work: help('The place to inspect tickets, Manager requests, activity, loops, and work that is already eligible to start.', 'Saved project plans, coordinator records, and optional Jira snapshots.', 'Open the relevant ticket or record, then follow its stated next action.'),
  projects: help('The factory’s saved project plans: projects, plans, phases, tickets, and saved artifacts. This is not the provider catalog.', 'The optional workCatalog file configured for this Console.', 'Choose a project to see its plan, or ask your agent to connect the existing workCatalog when it is missing.'),
  sessions: help('Recorded session assignments and Manager contact details. They do not prove an agent is currently working.', 'Saved project-plan session records and optional Manager snapshots.', 'Check the session’s assigned scope, then open its related work if you need more detail.'),
  factory: help('The operating view for resource signals, GM review, and factory or delivery blockers. It separates factory trouble from product work.', 'Saved coordinator and GM records; unknown measurements remain unknown.', 'Open the finding or review and follow the named owner’s next action.'),
  settings: help('The owner-controlled factory settings view. It shows what is loaded or saved, not proof that a provider, worker, or deployment is working.', 'Local Console configuration and its saved state.', 'Review the specific setting and its consequence before making an authorized change.'),
  decisions: help('The place to handle saved owner decisions. A response is separate from the Manager later acknowledging or resolving it.', 'Saved decision records and their evidence.', 'Open a decision, read its evidence, and make the requested decision.'),
  'role assignments': help(
    'The roles resolved for this factory, product, or pod. They express configured responsibility, not a live session, permission, or acceptance result.',
    'Loaded configuration and inherited overrides.',
    'Inspect the surrounding scope and change an assignment only through an authorized reviewed configuration update.',
  ),
  'settings unavailable': help(
    'The service did not publish usable factory settings, so the Console cannot safely display or edit them.',
    'The local Console settings snapshot; no configuration is guessed when it is absent.',
    'Update the owner-controlled local service configuration and restart the Console to republish settings.',
  ),
  'factory settings need a catalog': help(
    'This refers to saved factory settings—defaults, providers, products, and pods—not the project workCatalog plan index.',
    'No usable factoryConfiguration was published for this Console.',
    'Restore the approved factoryConfiguration in the same local Console JSON file, then restart the Console.',
  ),
  'restore factory settings': help(
    'Instructions for restoring missing factory settings without placing credentials or local paths in the browser.',
    'Owner-controlled local Console JSON configuration; this page cannot select or import files.',
    'Stop the Console, add the approved factoryConfiguration to its local JSON file, then restart it.',
  ),
};

const scopeFallbacks: Record<string, SectionHelp> = {
  main: help('This Console section summarizes saved factory records and actions for the selected view.', 'Coordinator and connected-service snapshots; values can be old or missing.', 'Use the linked record or next step before treating a status as a result.'),
  projects: help('This section explains a saved project-plan record and its ticket status.', 'The owner-maintained workCatalog file; it is a project-plan index, not the provider catalog.', 'Open the plan, phase, or ticket that carries the next concrete action.'),
  'project-plan': help('This is one saved plan within a project. It groups phases and tickets in the order the owner chose.', 'The workCatalog file; it does not schedule work or change a ticket’s status.', 'Read its phases, then open the ticket with the next action.'),
  'project-phase': help('This is one saved phase of a plan, with a goal and acceptance statement.', 'The workCatalog file; a phase is not complete until its applicable acceptance decision is recorded.', 'Read the acceptance statement and work through its tickets in order.'),
  'project-ticket': help('This is one saved ticket: its goal, dependencies, owner, and optional links to runs or requests.', 'The workCatalog file and explicitly linked records; a run or report does not change its status automatically.', 'Check dependencies, then open a linked run or request if one is shown.'),
  'manager-loops': help('This loop detail is saved execution history, not a live worker console.', 'Loop-runner records and attached delivery evidence; an old record does not establish liveness.', 'Follow the displayed next required delivery step.'),
  'manager-connected': help('This Manager-connected detail is an experimental handoff record, not independent acceptance.', 'Saved Manager snapshots and request records; contact time is not proof of activity.', 'Use a saved session and inspect the resulting request status.'),
  sessions: help('This session detail records assignment and contact context, not live activity or capabilities.', 'Saved workCatalog and Manager session records; missing fields remain unknown.', 'Check the assigned scope, then follow up through its linked work or Manager request.'),
  settings: help('This configuration section describes loaded or saved factory policy, not verified runtime behavior.', 'Owner-controlled local configuration; saved values can require restart before becoming active.', 'Review the exact setting and its stated consequence before making an authorized change.'),
  'settings-editor': help('This editor section changes a draft only until you review and confirm it.', 'Editable local configuration and preview validation; no provider credential or runtime verification occurs here.', 'Make a narrow draft change and inspect the review before saving.'),
  'role-assignments': help('Assign a provider, model, and Role Prompt: the standing instructions added when Faktori dispatches work through this role assignment. The task brief remains separate, and instructions cannot grant approval or publication authority.', 'Saved factory defaults, inherited by products and pods unless overridden. Existing external sessions do not receive these instructions automatically merely because they appear in Sessions.', 'Edit settings, enter concise responsibilities and handoff expectations, then review and save. Restart the Console safely to load changes. The foreman gets a job description, not a blank cheque.'),
  'ticket-board': help('Jira columns follow the configured board order, including empty columns. A column can contain several Jira statuses. Local tickets use their saved workflow.', 'Project plans and Jira board configuration. If column configuration is unavailable, the warning explains the fallback; tickets outside configured columns remain visible separately.', 'Open the ticket, project, Jira issue, or linked run for the original record. Change Jira columns in Jira, not here.'),
  'work-visibility': help('This section shows read-only Jira or activity snapshots in the selected scope.', 'Configured Jira sync and coordinator event summaries; neither is a live provider transcript.', 'Open the source record to act or check its current state.'),
  decisions: help('This decision section separates an owner response from later Manager acknowledgement or resolution.', 'Saved decision records and attached evidence.', 'Read the evidence and make the requested decision.'),
};

const generic = help(
  'This section shows one focused factory record. Its status is worth checking, not a shortcut around the next step.',
  'The Console’s current local snapshot; missing, old, or unverified values are not guessed.',
  'Open the related original record and follow its stated next action.',
);

const keyFor = (value: string): string => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');

export function sectionHelp(title: string, scope: string): SectionHelp {
  const key = keyFor(title);
  if (key.startsWith('resolved and withdrawn history')) return help('Older decisions that were resolved or withdrawn. They are kept for context, not as work still waiting for you.', 'Saved decision history; it can be limited by the Console’s retention rules.', 'Open an item only when its past evidence or decision helps with current work.');
  if (key.startsWith('product:')) return help('Settings that apply to this product after factory defaults and any product changes are combined.', 'Loaded factory configuration; it describes settings, not verified running behavior.', 'Expand the product and check its provider, environment, limits, and approval rules.');
  if (key.startsWith('pod:')) return help('Settings that apply to this pod after factory and product defaults are combined.', 'Loaded factory configuration; it describes settings, not verified running behavior.', 'Check the pod’s provider, environment, limits, and approval rules before starting work.');
  if (/^.+\s+\(\d+\)$/.test(key)) return help('Tickets in this saved status column. The number is the current visible count, not a promise that every ticket is current or ready.', 'Saved local-ticket or Jira status snapshots in this board.', 'Open a ticket for its goal, dependencies, and linked work records.');
  if (/^(to do|in progress|done|blocked|status not recorded)(\s|\d|—|-)/.test(key)) return help('Tickets in this saved status column. The count is what this board can currently show, not a promise that every ticket is current or ready.', 'Saved local-ticket or Jira status snapshots in this board.', 'Open a ticket for its goal, dependencies, and linked work records.');
  const aliases: Record<string, string> = {
    'connect your project plans': 'catalog unavailable',
    'project plans could not be loaded': 'catalog unavailable',
    'factory configuration is missing': 'factory settings need a catalog',
    'session assignments are not connected': 'assigned sessions',
  };
  return sections[aliases[key] ?? key] ?? scopeFallbacks[keyFor(scope)] ?? generic;
}
