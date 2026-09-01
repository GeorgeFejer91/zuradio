# Open music verification fixtures

The audio files in this directory are downloaded locally for performance and
browser upload testing. They are intentionally ignored by Git and never enter
the GitHub Pages artifact.

Source: [0lhi/FreePD](https://github.com/0lhi/FreePD), a public-domain music
catalog distributed under [CC0 1.0](https://github.com/0lhi/FreePD/blob/stream/LICENSE).
The repository preserves the catalog after the original FreePD website closed.

Files selected on 2026-09-01:

- `Electronic/Arpent.mp3` — SHA-256 `ef06d8b524c196a31954dfb1f3261e7d37459e43f4afd9df31ee2965c6094a56`
- `Epic/Adventure.mp3` — SHA-256 `18432184e1a3acf8095b8b45b688fe08f7afb2447fc6e3adc98cc944c541a733`
- `World/Nomadic Sunset.mp3` — SHA-256 `9b169280913ade05f804050a1887e6047a4f3dba85ec32101a20fcd62b884d72`

Run `scripts/fetch-test-music.sh` to download and verify all three files.
