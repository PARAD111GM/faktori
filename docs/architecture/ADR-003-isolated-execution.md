# ADR-003: Isolated execution is the default

Status: accepted

The recommended worker profile is a Docker container containing only the job
workspace, approved inputs, and selected provider credential profile. It has no
host home, Docker socket, factory journal, or publication credentials. Native
execution is an explicit owner choice for host-dependent tools and is recorded
as a materially broader trust boundary.
