# Third-party notices

Zuradio is greenfield MIT-licensed code. Architecture research includes projects
under MIT, Apache-2.0, BSD, GPL, and AGPL licenses. GPL/AGPL sources are treated
as behavioral and architectural references only; their source code is not copied.

The web bridge uses `@vdoninja/sdk`, which is distributed under MPL-2.0. Its
package and notices remain independently identifiable in the web bundle and
source tree. VDO.Ninja is an optional transport adapter, not part of Zuradio's
authorization boundary.

The Linux installer obtains the official Rust
[SongRec](https://github.com/marin-m/songrec) 0.7.5 package from its maintainer's
PPA, verifies the pinned package SHA-256, and installs its executable, copyright
notice, and exact source revision under `~/.local/lib/zuradio/songrec/`. SongRec
is GPL-3.0-or-later. It remains a separately licensed process: no SongRec code is
copied, linked, or loaded into the MIT Zuradio daemon, which communicates only
through a bounded command-line JSON interface. Redistributors must retain the
installed SongRec notices and satisfy its GPL source/license obligations.

Dependency-specific license inventory should be generated before any release.
