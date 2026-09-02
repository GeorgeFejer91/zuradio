#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

"$project_dir/scripts/verify-data-transfer.sh"
(cd "$project_dir/web" && npm run benchmark:vdo-binary)
(cd "$project_dir/web" && npm run benchmark:webrtc)
"$project_dir/scripts/benchmark-webtransport.sh"

printf 'Zuradio transport candidate benchmark suite passed.\n'
printf 'Artifacts: target/vdo-binary-benchmark.json, target/webrtc-data-plane-benchmark.json, target/webtransport-benchmark.json\n'
