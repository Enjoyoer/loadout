---
name: uv-python
description: >-
  Manage Python dependencies while preserving the project's existing workflow.
  Prefer uv for new projects and use it for an existing project when requested or
  needed for the scoped task; do not migrate requirements.txt-only projects merely
  because dependencies were touched.
---

# Python dependencies

First identify the project's existing dependency workflow from its committed files and documented commands. Preserve that workflow for existing projects. Prefer [uv](https://docs.astral.sh/uv/) for new projects, and use it for an existing project only when the user requests migration or the scoped task genuinely requires it.

## New project

```powershell
uv init
uv add <package>
```

Commit `pyproject.toml` and `uv.lock`. Add `.venv/` to `.gitignore` if missing.

## Existing uv project

After editing `pyproject.toml` or changing dependencies:

```powershell
uv lock
uv sync
```

On clone or a new machine, use the project's documented setup, normally:

```powershell
uv sync
```

## Existing non-uv project

Keep its current requirements, lockfile, package manager, and setup commands. Do not add `pyproject.toml`, create `uv.lock`, or remove `requirements.txt` automatically. If the user requests migration, or the scoped task cannot be completed without it, agree the migration boundary first and preserve the existing dependency set while moving it to uv.

For a requested or necessary `requirements.txt` migration:

```powershell
uv init
uv add -r requirements.txt
uv lock
uv sync
```

Remove or archive `requirements.txt` only after the user-approved migration is committed and the new lockfile reproduces the required environment.

## Rules

- Prefer `uv add <package>` over manual `pyproject.toml` edits in uv-managed projects when possible.
- Run the existing project's required lock and sync/install checks after dependency changes.
- Never commit `.venv/`.
- Do not replace a working existing dependency workflow with uv without an explicit request or a concrete scoped necessity.
