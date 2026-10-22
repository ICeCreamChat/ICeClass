# Native island running layers

`body-running.webp`, `leg-left.webp` and `leg-right.webp` are lossless separations
of the existing user-supplied Banban artwork at
`web_controller/assets/banban/body.webp`. No new character artwork is substituted.

Regenerate with `scripts/prepare-island-banban-legs.py` (Pillow). All layers keep
the source's 640 × 819 canvas and share the same rig coordinates. Their pixels
recombine into the original body at rest; only the two feet move during pulling.

The retained reference sprites `holding-bent.webp` and
`holding-hand-horn-left.webp` use the user-supplied
`Gemini_Generated_Image_ikudjpikudjpikud.jpg` (2400 × 1792), supplied on
2026-10-22. Source SHA256:
`56f4055ea79689b17c0df49f7f1153e56bf5d203b416dd750d74f9b64fdbb804`.

Regenerate these two resources with `scripts/prepare-island-banban-grip.py`
using `--source`, `--output` for review separations and `--assets
Receiver/Assets/Banban`. The JPEG's connected white background is removed
while closed cream interiors remain opaque. The blue horn is reflected around
the rear grip to face left; painted fingers, thumb and grip pixels are retained.
The proximal wrist cap fades into the overlapping bent-arm sprite. The combined
hand/megaphone bitmap then moves rigidly at one constant scale.

The extracted pieces and three complete arm poses remain review references.

## Supplied complete-pose grip (2026-10-22)

`holding-supplied.webp` is a lossless transparent extraction of the user's
`Gemini_Generated_Image_3h1gxi3h1gxi3h1g.jpg` (2048 × 2048).
Source SHA256:
`8b99e510be9268d6bd5f7f15f7d337872c62a01eb2a74cfeb61920c78777ae6a`.

The second supplied image, `Gemini_Generated_Image_k6tu91k6tu91k6tu.jpg`
(2400 × 1792), is retained as an assembly reference. Its arm's proximal direction
differs from the complete pose, so the complete pose supplies production pixels.
Reference SHA256:
`bc35b043f34e8d94f36d53360d1400f269470599e471bdabd18f10bcf57dcc51`.

Reproduce the extraction with `scripts/prepare-island-supplied-grip.py --source
<complete-pose.jpg> --output <review-folder> --assets Receiver/Assets/Banban`.
The white background and unrelated book-spine pixels are removed. The 862 × 835
sprite retains the supplied forearm, fingers, thumb and blue horn together,
without reflection or redrawing. The crop is (124, 505, 986, 1340) in source pixels.

`IslandBanbanHoldingArm.cs` registers source shoulder (363, 612), grip (539, 663)
and mouthpiece (854, 439) at a fixed scale. The entire sprite rotates rigidly at
the shoulder; no separate elbow, wrist or finger deformation is introduced.
The raised mouthpiece reaches the existing mouth. Only the sound lines are native
paths in `IslandBanbanMegaphone.cs`. The larger horn has an additional 4 DIP of
left clearance during urgent running. The original body, face, badge, right arm,
feet and both other notice modes retain their existing artwork and behavior.

The earlier procedural hand and legacy holding bitmaps are no longer drawn.

Reproduce native pose renders with
`dotnet run --project tests/ReceiverOfflineChecks -- --island-arm-review output/island-hand-review`.
The review is rendered through the production mascot, not a separate illustration.

Local compositing target: `output/island-supplied-grip-20261022/supplied-grip-target.png`.
