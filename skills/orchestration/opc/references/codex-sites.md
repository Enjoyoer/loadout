# Codex Sites

Codex Sites is OpenAI's hosted deployed-web-app surface in Codex, invoked with `@Sites` or by putting "website" in the prompt, and managed at chatgpt.com/sites or the desktop Sites section. Sites is a capability OPC may use, not an OPC outcome. OPC's user-facing outcome stays [merge](../SKILL.md#7-merge-and-cleanup "runtime"): repo-resident local Sites project source is delivered by merge, and the hosted Site is a separate surface whose state is reported, not merged.

## Route and model

Sites interaction runs as a durable, separately scheduled Codex agent that survives the PM being steered, at `gpt-5.6-luna`, `xhigh` reasoning, Fast on. When it may edit repository files, launch it under the managed worktree, unattended permission, and notification requirements in the [Worker placement](imp-execution.md#worker-placement "runtime"). This fixed contract applies only to Sites interaction.

## Fallback boundary

Sites does not have a standalone Codex CLI management view. Creating, saving, deploying, sharing, and managing a Sites project happens in ChatGPT web or the desktop app; the CLI and the IDE extension can only edit and test a local project before publishing, and neither exposes analytics. Therefore `codex exec` cannot create, save, deploy, share, change audience, manage settings or secrets, restore a version, transfer ownership, or read analytics. A failed native route returns blocked hosted operations to the user. Local edit and test work may continue only through a normal OPC editing Worker in its own managed worktree, never by falling back into the PM checkout.

For uncertain execution or cancellation, use [recovery](recovery.md "branch:recovery").

## Deploy authority

Publishing is two stages: saving a version, which is a reviewable build candidate tied to a Git commit for local projects, and deploying it, which returns the production URL. Every Sites deployment URL is a production deployment. Deploys are authorized by the OPC run and need no separate per-deploy ask, but because there is no staging URL, prefer saving a version without deploying when the build is not yet verified. Report the production URL and the audience setting in delivery.

New Sites start limited to the owner and workspace admins. Audience can scale to selected users or groups, invited external viewers, workspace-wide, or public; in Enterprise, public publishing is off by default and must be enabled by an admin.

## Access and secrets

Environment variables and secrets are managed only in the Site's settings in web or desktop, not in `.openai/hosting.json`, and take effect only after a redeploy of the approved saved version.

Editors cannot change audience, invite or remove people, manage settings or analytics, restore an earlier version, transfer ownership, or perform the first publish; editors can read live database data. Treat a first publish and any audience change as owner-only and therefore user-side when the acting account is an editor.
