# Changelog

All notable changes to the mwcode desktop app. The engine it runs on has its own changelog in [mindweave](https://github.com/mindweave-cli/mindweave).

## 1.0.0

First public release of mwcode for Windows, Linux and macOS.

### Chat
- One chat screen per project, with a sidebar of sessions you can search, pin and rename.
- Queued messages: keep typing while the agent works and your message goes next.
- Attachments, a live context meter, and automatic compaction when a session gets long.
- Rewind: step a conversation back to an earlier message and continue from there.
- Run: start a project's command from the chat and watch its output.
- Marathon: give the agent a long goal and let it work through it, with live progress.

### Providers and models
- Bring your own keys for the supported providers, or run models locally with Ollama.
- Keys, sessions and settings are shared with the mindweave command line, so nothing is entered twice.
- If you already use the command line, your projects are picked up automatically on first launch.

### Updates
- The app checks for a newer version in the background and tells you when there is one. Nothing is downloaded until you press Update, and it installs when you restart.
- Every update is signed. The app only installs one signed with the key built into it, and it checks the file against the signed size and fingerprint twice, once after the download and again just before installing. An older release cannot be pushed over a newer one.
- It updates itself on Windows, on macOS (even though the app is not signed by Apple) and from a Linux AppImage. A Linux .deb, or a Mac app in a folder it cannot change, shows the download page instead.
- One update covers the app, the core and the command line, because they travel together.
- Nothing about you is sent when it checks.

### Settings
- Providers, MCP servers, Permissions, Rules, Tokens and usage limits, Quick Tabs, Analytics, What's new and About.
- Launch at login is off by default.

### What's new and feedback
- A signed news feed shows what's new. Updates are checked against the feed, never installed silently.
- Send feedback from inside the app.

### Platforms
- Windows: installer and uninstaller, with the command line included.
- Linux: .deb and AppImage, native resize border, rounded window.
- macOS: Apple silicon build with native window controls and menu.

### Project
- Apache-2.0 licensed. Source: https://github.com/mindweave-cli/mwcode
