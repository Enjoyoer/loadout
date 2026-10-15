---
name: project-icon
description: Give a Paseo project its first custom icon in a consistent die-cut sticker style. Use when a PM first takes ownership of a project with no custom icon.
metadata:
  version: "1.0"
---

# Project icon

Run once at first PM ownership, only for a project with no custom icon. Do not redesign existing icons. Skip roots at or below `~/.cache/fleet-scratch` (Windows: `%USERPROFILE%\.cache\fleet-scratch`). Keep drafts, renders, and previews in scratch, not the project or public skill package.

## Spec sheet

| Property | Requirement |
| --- | --- |
| Canvas | 512x512 SVG, transparent background, rendered to 512x512 PNG |
| Art | One flat enamel-style motif, bold saturated palette, simple chunky shapes |
| Edge | White die-cut border plus faint hairline, using the unchanged shared `cut` filter in `assets/template.svg` |
| Motif | A concrete object that visually puns on what the project does; no text, letters, wordmarks, or generic initials |
| Distinction | Inspect the user's existing project icons locally; choose a different silhouette and dominant color. Never publish their inventory or contact sheet |
| Detail | A few large internal features, no fussy lines, gradients, photorealism, or background tile; leave about 32 px clearance for the cut edge |
| Acceptance | Recognizable at 40 and 20 px at actual size on both white and dark backgrounds; border unbroken and unclipped |

## Detect before drawing

Resolve the exact project ID and root with `paseo project ls --json`. Locate the installed Paseo CLI's `dist` directory beside its `bin` directory (resolve the `paseo` executable, then inspect its package). The helper imports that installation's `utils/client.js` and `utils/daemon-target.js`, using its existing transport and authentication. Requires Node and a compatible Paseo client exposing `listProjects`, `setProjectIcon`, and `getProjectIcon`.

```sh
node <skill>/scripts/apply-icon.mjs <cli-dist> <project-id> --check
```

Detection reads the raw `client.listProjects().projects` record: `projectCustomIconRevision` is null for no custom icon, a nonempty string for a custom icon. In the daemon's projects store the corresponding field is `customIconRevision`. The formatted CLI list omits it. Do not mistake `projectIconRevision` (which can describe an automatic icon) for a custom icon. Missing or unknown fields fail closed. `--check` reports `hasCustomIcon`, `scratch`, and `status` without changing anything. Stop if custom or scratch; do not generate art for skipped projects.

The default is the local daemon selected by the installed CLI, not an inherited `PASEO_HOST`. For explicit remote use, supply both `--host <endpoint>` and `--scratch-root <absolute-daemon-scratch-root>` on every invocation. Remote roots must be canonical daemon paths, with symlinks resolved beforehand; local detection resolves symlinks itself. Never use the caller's home to infer a remote scratch root.

## Draw, render, inspect

Copy `assets/template.svg` to scratch and insert only the new motif inside the filtered group. Keep the generic filter head/tail unchanged. The template intentionally contains no project artwork.

```sh
python3 <skill>/scripts/render.py <draft.svg> <icon.png>
```

Rendering uses **librsvg's `rsvg-convert`**, not CairoSVG or a browser fallback. Install librsvg if missing. The helper also writes `<icon>.preview.html` with actual-size 512, 40, and 20 px renders on light and dark. Open it locally at 100% zoom. Inspect every size/background before upload; simplify the motif if it loses identity. Do not upload until the visual check passes.

## Apply and verify

```sh
node <skill>/scripts/apply-icon.mjs <cli-dist> <project-id> <icon.png>
```

The helper rechecks the project immediately before writing, refuses scratch roots, refuses an existing custom icon without `--force`, uploads through `setProjectIcon`, then compares `getProjectIcon().icon.data` byte-for-byte and confirms the custom revision. It reports `verified: true` only on success. Serialize icon writers for a project: the daemon has no compare-and-set icon RPC, so the recheck cannot exclude a simultaneous writer. If upload returns an uncertain error, inspect state before retrying; do not blindly force.

`--force` is only for an explicitly requested replacement, never routine PM intake. `--allow-scratch` independently overrides the scratch skip only for an explicitly requested throwaway verification. Neither implies the other. A second normal apply must refuse after a successful upload. Finish with `--check` and report the verified result or concrete blocker; never clear an existing icon to make intake run again.
