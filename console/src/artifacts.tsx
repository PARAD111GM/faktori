import { useEffect, useMemo, useState } from 'react';

import { HelpHeading, HelpSummary } from './section-help.tsx';
import { Artifact } from './projects.tsx';
import type { WorkManagementProjectProjection, WorkManagementState } from '../../src/console/work-management.ts';

function ProjectArtifacts({ project }: { project: WorkManagementProjectProjection }) {
  const intent = project.artifacts.find((artifact) => artifact.role.toLocaleLowerCase() === 'intent');
  const intentAvailable = intent?.status === 'available';
  return <section className="artifact-project" aria-label={`${project.title} artifacts`}>
    <div className="panel-heading"><div><HelpHeading level={3} scope="artifacts">{project.title}</HelpHeading><p>{project.goal}</p></div><strong>{project.artifacts.length} recorded</strong></div>
    {!intentAvailable && <div className="artifact-intent-missing"><strong>{intent ? 'INTENT is unavailable or stale' : 'INTENT is not recorded'}</strong><p>No approval or intent is inferred. {intent ? 'Restore a current safe observation or owner-published snapshot for the canonical INTENT artifact.' : 'Add the canonical INTENT artifact to this project’s configured work catalog and artifact home, then let the Console observe or publish its safe snapshot.'}</p></div>}
    {project.artifacts.length === 0
      ? <p className="quiet">No artifacts are recorded for this project. This does not mean its files were searched.</p>
      : <div className="artifact-list">{project.artifacts.map((artifact) => <Artifact key={artifact.id} artifact={artifact} />)}</div>}
  </section>;
}

export function Artifacts({ workManagement, initialProjectId, onProjectChange }: { workManagement?: WorkManagementState; initialProjectId?: string; onProjectChange?: (projectId?: string) => void }) {
  const [projectId, setProjectId] = useState(initialProjectId ?? '');
  useEffect(() => { setProjectId(initialProjectId ?? ''); }, [initialProjectId]);
  const projects = workManagement?.projects ?? [];
  const visible = useMemo(() => projectId ? projects.filter((project) => project.productId === projectId) : projects, [projectId, projects]);
  const chooseProject = (next: string): void => { setProjectId(next); onProjectChange?.(next || undefined); };
  if (!workManagement || workManagement.status === 'unavailable') return <section className="workspace artifacts-workspace"><div className="panel panel-primary"><div className="empty"><HelpHeading level={2} scope="artifacts">Artifact catalog unavailable</HelpHeading><p>The Console cannot safely show artifacts until its project catalog is configured and readable. No filesystem contents were searched or guessed.</p><p>Configure the canonical project work catalog and each project’s artifactHome on the local Console service, then restart only the Console when it is safe to do so.</p>{workManagement?.error && <details><HelpSummary scope="artifacts">Technical details for your agent</HelpSummary><code>{workManagement.error}</code></details>}</div></div></section>;
  return <section className="workspace artifacts-workspace"><section className="panel panel-primary artifacts-header"><div className="panel-heading"><div><p>Safe catalog observations and owner-published snapshots. They are not live filesystem browsing.</p></div><strong>{projects.reduce((count, project) => count + project.artifacts.length, 0)} recorded</strong></div><label>Project<select aria-label="Artifact project" value={projectId} onChange={(event) => chooseProject(event.target.value)}><option value="">All projects</option>{projects.map((project) => <option key={project.productId} value={project.productId}>{project.title}</option>)}</select></label></section>
    {visible.length === 0 ? <div className="panel panel-primary"><div className="empty"><HelpHeading level={3} scope="artifacts">No matching project artifacts</HelpHeading><p>No project matching this filter is currently published by the catalog.</p></div></div> : <div className="artifact-projects">{visible.map((project) => <ProjectArtifacts key={project.productId} project={project} />)}</div>}
  </section>;
}
