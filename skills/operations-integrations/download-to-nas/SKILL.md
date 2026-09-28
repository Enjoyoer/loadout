---
name: download-to-nas
description: Use when the user wants a torrent, magnet, or direct URL downloaded or staged for a NAS, with source, quality, size, health, ETA, and destination compared; queue torrents in qBittorrent using the user's configuration. Use optional subtitle recipes only when requested.
---

# Download to NAS

Goal: help the user safely find, compare, queue, and place NAS downloads, including direct URLs, while following the destination and selection preferences supplied in the request or local configuration.

## User Request Format

When asking for a download, give as many fields as you know. The key fields are `Name`, `Type`, `Destination`, and whether to `Auto-add`.

```text
/download
Name: <thing to download>
Type: movie | tv | iso | software | music | photos | files
Source: official | public-domain | creative-commons | my-url | unsure
Quality: 4K | 1080p | 720p | original | smallest | any
Destination: Jellyfin | FileBrowser | Photos/Immich | Downloads only | specific NAS path
Priority: best quality | smallest size | fastest | most reputable
Auto-add: no | yes
```

How to interpret destination:

- `Jellyfin`: for a torrent, download through qBittorrent; for a direct URL, stage locally; then place the completed video under the user's configured Jellyfin media root using clean library naming.
- `FileBrowser`: for a torrent, download through qBittorrent; for a direct URL, stage locally; then place completed files under a user-approved share that FileBrowser serves.
- `Photos/Immich`: stage under the user's configured photo import share.
- `Downloads only`: leave the completed download in qBittorrent's configured download/completed location; do not move it.
- Specific NAS path: use the exact user-provided path after checking it exists or creating a safe child folder.

Parse these fields on `/download` and `/download-to-nas` requests. Missing fields are okay. Infer from context or ask only for what blocks progress. If `Auto-add: yes` and the user gave an exact magnet or `.torrent`, queue after a brief summary; for an exact direct URL, stage it locally after the summary; otherwise show candidates first. Always state the transfer staging path (qBittorrent's save path for torrents) and the final NAS destination path before queueing or staging.

## Hard rules

- Use sources the user is authorized to download: official Linux/BSD ISOs, vendor downloads, public-domain or Creative Commons media, user-owned files, official release torrents, and user-provided URLs or magnets with appropriate rights.
- Before adding anything to qBittorrent, show candidates and wait for user selection unless the user explicitly gave one exact URL or magnet.
- Never print qBittorrent credentials, SMB passwords, tokens, or tracker passkeys.
- **Torrents run on the NAS qBittorrent only.** Never download a torrent on the local PC (no aria2, no transmission, no qBittorrent-on-Windows fallback), even if the NAS is slow, firewalled, or stalled. A stalled item authorizes relevant read-only diagnosis of qBittorrent, trackers, DHT, VPN, or reachability; it does not authorize port-forward, VPN, firewall, router, or other network changes. Ask before any such mutation. Anything with a magnet or `.torrent` must go through NAS qBit.
- Plain HTTP/HTTPS non-torrent downloads may be staged locally when the user requests them, then routed to the exact NAS destination. They do not weaken the NAS-only torrent rule.

## NAS configuration

Resolve the qBittorrent WebUI URL, NAS host, staging share, media roots, and photo import share from the user's configuration or request. Ask for a missing path before queueing or moving files; do not infer one from this skill. Use a private connection to the WebUI. Do not change backup destinations or move bulk data without explicit approval.

## Workflow

1. Classify request.
   - If ambiguous, ask for rights/source clarification.

2. Discover options.
   - Prefer official vendor/project pages and official torrent links.
   - For public-domain/CC media, prefer Internet Archive, creator pages, or official distribution pages.
   - If web browsing/search is available and current source data matters, browse.
   - For user-provided magnet, torrent, or direct URL, validate basic shape and source context.

3. Compare candidates.
   - Show title/name, source, format/quality, size, seed/peer health when available, expected destination, estimated ETA when enough info exists, and risk notes.
   - Prefer reputable source, exact match, appropriate quality/size, then healthier swarm.
   - Do not choose silently unless the user asked for auto-pick.

4. Queue download.
   - Use qBittorrent WebUI/API if credentials are available in session.
   - Set category/tags when useful: `movies`, `tv`, `music`, `isos`, `files`, `photos`.
   - Use a staging path if the final destination requires post-download organization.
   - Confirm queue state, save path, size, progress, and ETA.
   - If the item stalls, inspect status read-only and report the likely cause and safe options. Do not change network, VPN, port-forward, firewall, or tracker settings automatically.

   - For a direct HTTP/HTTPS URL, stage the non-torrent bytes locally with the existing direct-download workflow, then copy them to the exact NAS destination. Do not route a direct URL through qBittorrent unless the user asks.

5. Place completed files.
   - Jellyfin movie: place under `<MOVIES_ROOT>/<Clean Title (Year)>/`.
   - Jellyfin TV: place under `<TV_ROOT>/<Show>/Season NN/`.
   - General files: place under an approved share for FileBrowser.
   - Preserve existing naming conventions. Inspect target directories before creating new ones.
   - Avoid overwriting. If there is a collision, ask.

6. Validate.
   - qBittorrent item exists, with status/progress visible.
   - Destination exists and permissions match surrounding files.
   - If Jellyfin route, confirm Jellyfin can see the path or document that a refresh is needed.
   - If files route, confirm FileBrowser path is reachable through the NAS share.

## Optional post-download recipes

Use the optional [Jellyfin subtitle recipe](references/subtitles.md) only when the user asks for subtitle inspection or sidecar placement. It is separate from normal torrent queueing and never changes the NAS-only torrent rule.

## qBittorrent API hints

Use WebUI API only over the user's private network:

```text
POST /api/v2/auth/login
POST /api/v2/torrents/add
GET  /api/v2/torrents/info
POST /api/v2/torrents/setLocation
POST /api/v2/torrents/createCategory
```

If credentials are missing, ask the user to provide or store them. Do not guess or scrape browser passwords.

## Output style

Keep output short:

- `Options`: ranked list.
- `Recommended`: one option with reason.
- `Destination`: exact NAS path.
- `Before queue or stage`: ask for selection unless an exact URL was given.
- `After queue or stage`: progress, ETA when applicable, path, and next validation.
