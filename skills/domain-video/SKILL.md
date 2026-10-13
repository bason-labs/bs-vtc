---
name: domain-video
description: "Video streaming domain pack (VTC spec 5.2a). Load when the repository or the specification shows video encoding, packaging or playback (ffmpeg pipelines, HLS or DASH manifests, players); adds the domain's rules to the Engineer and the reviewers. Cite rule ids in findings."
---

# Video streaming domain pack

Load when: video encoding, packaging or playback (ffmpeg pipelines, HLS or DASH manifests,
players).

## Rules

- **VID-1** Optimise time to first frame and rebuffering before peak quality.
- **VID-2** Package once (fragmented MP4 or CMAF) and serve both HLS and DASH from it.
- **VID-3** The bitrate ladder fits the content; always include a low startup rung.
- **VID-4** Choose segment duration deliberately for the latency target.
- **VID-5** DRM licence requests run in parallel with startup, never blocking it unmanaged; key
  rotation is tested.
- **VID-6** Manifests are short-lived in caches, segments long-lived; cache keys exclude volatile
  parameters.
- **VID-7** Playback is tested on throttled and lossy networks, not only a fast connection.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE): engineering-video-streaming-
engineer.md.
