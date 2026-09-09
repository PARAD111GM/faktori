# Jira activity in Console

Faktori can observe owner-selected Jira projects as a read-only Console source. It polls Jira from the local server, keeps a sanitized in-memory snapshot, and never lets the browser choose a Jira URL, project, query, or credential.

This observer is optional. With no `jiraSources` entries, Faktori makes no Jira requests and the Console remains fully usable.

## Configuration

Add an allowlisted source to the local Console configuration:

```json
{
  "jiraSources": [
    {
      "id": "demo-board",
      "baseUrl": "https://example.atlassian.net",
      "projectKey": "DEMO",
      "productId": "demo-project",
      "podId": "example-pod",
      "authorizationEnv": "DEMO_JIRA_AUTHORIZATION",
      "pollIntervalMs": 60000
    }
  ]
}
```

`baseUrl` must be an HTTPS origin with no user information, path, query, or fragment. `projectKey` is restricted to a bounded uppercase Jira key. `productId` and `podId`, when present, must match the resolved factory catalog; a pod always requires its product. Polling cannot be configured more frequently than once every 15 seconds.

`authorizationEnv` is an environment variable **name**, not a token. Its server-side value must be the complete HTTP `Authorization` header value accepted by the Jira site. Set it only in the environment that starts the local Console. Do not put the value in Faktori configuration, checked-in files, browser storage, command output, or documentation.

## Observed data

The observer uses Jira's enhanced search endpoint with a fixed project query and requests only issue key, summary, status, status category, assignee display name, and updated time. It follows at most ten pages and retains at most 500 issues per board. An initially bounded result can show an explicit incomplete-snapshot notice. If any later bounded result would replace a prior snapshot, Console keeps the prior snapshot and marks it stale and truncated instead.

Descriptions, comments, attachments, account identifiers, raw Jira responses, request errors, environment variable names, and authorization values are not exposed in the snapshot. Malformed or out-of-project issues reject the whole poll instead of silently producing an incomplete board.

The first successful poll creates one board-level activity summary. Later activity is created only when an already-observed issue actually changes status. Repeated snapshots do not create repeated activity, and the cache retains at most 100 activity entries per board.

Console activity has different durability depending on its source. Actual run progression is rebuilt from the durable coordinator journal, and Manager Loop milestones are rebuilt from their allowlisted artifacts, so both survive Console restarts. Jira status-change activity is a bounded, session-local comparison cache: restarting Console clears that activity history and begins with one new initial-sync summary. Jira itself remains the durable authority for issue history.

## Availability and recovery

Before the first successful poll, the source is truthfully `unavailable`. A successful poll is `connected`. Missing server authorization and Jira access denial receive fixed, actionable messages without naming an environment variable or exposing a provider response. If a later request times out, redirects, exceeds the response bound, returns malformed data, or otherwise fails, the last complete issue snapshot is retained and marked `stale`. A failed later page never removes tickets learned from an earlier complete poll.

The observer is read-only: it does not create, edit, transition, assign, or comment on Jira issues. Restarting the Console clears its in-memory snapshot and Jira activity history.
