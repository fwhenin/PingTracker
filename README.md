# PingTracker

A small menu bar (macOS) / system tray (Windows) app that runs a ping test on a schedule, stores every result locally and shows the history as graphs.

## Features

- **Scheduled ping tests.** Pick how often to test: every 1, 2, 5, 10, 15, 30 or 60 minutes. Change it from the dashboard or straight from the tray menu (*Test Every*).
- **Choose what to ping.** Your router (the default gateway, auto-detected), Cloudflare `1.1.1.1`, Google `8.8.8.8`, Quad9 `9.9.9.9`, plus any custom host name or IP. Enable as many as you like; each one is tested every run.
- **Choose the network interface.** Leave it on *Automatic* or pin the tests to a specific interface (e.g. Wi-Fi vs. Ethernet). The router target follows the chosen interface.
- **Lives in the menu bar / tray.** The icon turns green, amber (packet loss or slower than your threshold) or red (no reply). On macOS the latest latency is shown next to the icon. The menu shows the latest result per target, *Run Test Now*, *Pause/Resume*, the interval and *Open Dashboard*.
- **Dashboard with history graphs.** Latency and packet loss over the last 1h / 6h / 24h / 7d / 30d, per-target cards (current, average, 95th percentile, jitter, loss) and a table of recent tests.
- **Stored locally.** History is kept in a SQLite database in the app data folder (`~/Library/Application Support/com.fwhenin.pingtracker` on macOS, `%APPDATA%\com.fwhenin.pingtracker` on Windows). Retention is configurable (7 days to forever) and you can export everything to CSV.
- **No admin rights needed.** Pings use unprivileged ICMP sockets on macOS and the `IcmpSendEcho2Ex` API on Windows.
- Optional *Launch at login*. Closing the dashboard keeps the app running in the tray; quit from the tray menu.

Each test sends a configurable number of pings (default 5) and records min / average / max round-trip time, jitter and packet loss.

## Download

Grab the latest installers from [Releases](https://github.com/fwhenin/PingTracker/releases):

- `PingTracker_<version>_universal.dmg`: macOS 10.15+ (Apple Silicon and Intel)
- `PingTracker_<version>_x64_en-US.msi`: Windows 10/11

The builds are not code-signed yet:

- **macOS:** after dragging PingTracker to Applications, right-click it and choose **Open** the first time (or run `xattr -dr com.apple.quarantine /Applications/PingTracker.app`).
- **Windows:** SmartScreen may warn about an unknown publisher; choose **More info → Run anyway**.

## Branches and releases

| What you push | What GitHub Actions does |
|---|---|
| A pull request, or a commit to `main` | Builds the `.dmg` and `.msi` and attaches them to the workflow run as artifacts (**Actions → Build installers → Artifacts**). No release. |
| A branch named `release/X.Y.Z` (e.g. `release/1.2.0`) | Builds both installers with version `X.Y.Z`, then creates the tag `vX.Y.Z` and a GitHub Release with the `.dmg` and `.msi` attached and release notes. |
| A tag named `vX.Y.Z` | Same as a release branch, if you prefer tagging. |

To cut a release:

```sh
git checkout main && git pull
git checkout -b release/1.2.0
git push -u origin release/1.2.0
```

About 10–15 minutes later, **PingTracker 1.2.0** appears under Releases. Pushing more commits to the same release branch (for a last-minute fix) rebuilds and replaces the files on that release, and the tag moves to the new commit. Merge the release branch back into `main` afterwards if it has fixes.

- The version comes from the branch or tag name, so you don't need to edit any files to bump it. It must be `X.Y.Z`, or `X.Y.Z-N` for a pre-release (e.g. `release/1.2.0-1`), because Windows installers only accept numeric versions. Pre-releases are marked as such and don't become "Latest".
- Release notes start with download and install instructions, followed by GitHub's auto-generated list of merged pull requests and contributors since the previous release. Pull requests are grouped by label (`feature`/`enhancement`, `bug`/`fix`, everything else); label one `skip-changelog` to leave it out. You can edit the notes on GitHub after publishing.

## Development

Built with [Tauri 2](https://tauri.app) (Rust backend, plain HTML/JS dashboard with Chart.js).

Prerequisites: Node.js 20+, Rust (stable), and the [Tauri system prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri dev      # run the app with hot reload
npm run tauri build    # build installers for the current OS
cd src-tauri && cargo test
```

`npm run dev` on its own serves the dashboard in a normal browser with mock data, which is handy for UI work.

### Layout

| Path | What it is |
|---|---|
| `src-tauri/src/ping.rs` | ICMP echo implementation (macOS/Linux datagram sockets, Windows IcmpSendEcho2Ex) |
| `src-tauri/src/net.rs` | Interface listing and default gateway detection |
| `src-tauri/src/store.rs` | SQLite history, bucketed series, summaries, CSV export |
| `src-tauri/src/settings.rs` | Settings model and persistence |
| `src-tauri/src/lib.rs` | Scheduler, tray menu, commands, app setup |
| `src/` | Dashboard UI |
| `.github/workflows/build.yml` | CI that builds the `.dmg` and `.msi` and publishes releases |
| `.github/release.yml` | How auto-generated release notes are grouped |
