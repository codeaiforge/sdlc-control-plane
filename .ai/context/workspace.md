# Workspace context

The Nx project graph is the canonical, machine-readable model of this repository's
projects and dependency boundaries. Use the workspace package manager to query the graph
before proposing structural changes. `docs/` records the intent behind that graph.

Project tags and dependency constraints are part of the architecture. Update the graph
and its documented intent together; do not encode architecture independently in an agent
adapter.
