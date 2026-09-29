# Optional Jellyfin subtitle recipe

Use this recipe only after the video is in place and the user asks for subtitle inspection or sidecar placement. Do not assume a sidecar is needed.

1. Probe the MKV for embedded subtitle tracks. If `ffprobe` is unavailable on the NAS host, use the Jellyfin container's bundled binary. Resolve the container's movie mount separately from the NAS host path.

   Run `ffprobe -v error -select_streams s -show_entries stream=index,codec_name:stream_tags=language,title -of default=noprint_wrappers=1` against the movie path inside the Jellyfin container. Set the NAS host, container name, and container movie path from the actual deployment (see `local.md` when present); the container path may differ from the NAS host path.

   If jellyfin-ffmpeg is unavailable, use `mkvmerge -i` or `mkvinfo` from an mkvtoolnix container, or another container with ffmpeg.

2. Decide from the embedded tracks:
   - An English text track (`subrip`, `ass`, or `mov_text`) means the video is done. Do not add a sidecar. Remove any partial local sidecar artifacts.
   - Only image-based English (`hdmv_pgs_subtitle`, `dvd_subtitle`, or VOBSUB) means a text sidecar may help; PGS is heavier and cannot be styled.
   - No English track means find a text sidecar.

3. Find an English `.srt` source. Prefer SubIndex, whose page JSON exposes direct `dl.opensubtitles.org` `.gz` URLs:

   ```text
   https://www.subindex.org/movies/<slug>/english
   ```

   OpenSubtitles web searches may require an API key or browser session. Do not rely on a blocked direct search.

4. Download the `.gz` on the local PC over HTTPS, not on the NAS. This is a plain HTTP(S) subtitle download, not a torrent, so the NAS-only torrent rule does not apply.

   ```powershell
   Invoke-WebRequest -Uri '<dl.opensubtitles.org .gz url>' -OutFile "$env:TEMP\sub.gz"
   ```

   Decompress locally and inspect the first lines for ad or branding spam.

5. Name the sidecar to match the video basename plus a language code, then copy it into the movie or show folder:

   ```text
   <release>.en.srt          # primary English
   <release>.<lang>.srt      # additional languages
   ```

   Copy the inspected `.srt` from the local PC to the matching media directory on the NAS. Use the shell's native local path syntax and quote paths containing spaces.

6. Match ownership and permissions to surrounding Jellyfin media. Inspect them before changing anything:

   On the NAS, apply the same owner, group, and permission mode as adjacent media files to the new sidecar.

7. Trigger a Jellyfin library scan or wait for its watcher. If the subtitle comes from a different release, note that a constant A/V offset may remain and can be adjusted in the player.
