# mwcode

The desktop app for [Mindweave](https://github.com/mindweave-cli/mindweave), a coding agent that runs
on your own machine. You bring a key for the model provider you like (or run models locally with
Ollama), open a project folder, and work with the agent in a chat: it reads, searches and edits your
code, runs commands, and checks its work with the language server.

mwcode is the app around the agent. The agent itself (the engine, the model drivers and the `mw`
command line) is the **Mindweave core**, which lives in its own repository and ships inside every copy
of the app.

| Repository | What it is |
| --- | --- |
| [mindweave-cli/mwcode](https://github.com/mindweave-cli/mwcode) | this app: the window, the chat, settings, packaging |
| [mindweave-cli/mindweave](https://github.com/mindweave-cli/mindweave) | the core: the agent, the providers, the `mw` CLI |
| [mindweave-cli/mindweave-news](https://github.com/mindweave-cli/mindweave-news) | the signed feed behind the app's What's new page |

## Download

Get the latest version from [Releases](https://github.com/mindweave-cli/mwcode/releases).

| System | File | Notes |
| --- | --- | --- |
| Windows 10/11 (64-bit) | `mwcode-Setup-<version>.exe` | Installer and uninstaller. Adds `mw` to your PATH. |
| Linux (Ubuntu, Debian and relatives) | `mwcode_<version>_amd64.deb` | `sudo apt install ./mwcode_<version>_amd64.deb`. Adds `mw` to your PATH. |
| Linux (any) | `mwcode-<version>-x86_64.AppImage` | Make it executable and run it. |
| macOS 13+ on Apple silicon | `mwcode-<version>-mac-arm64.zip` | Unzip, move to Applications. See below. |

Every copy includes the `mw` command line and the Node it runs on, so nothing else has to be
installed. If you already use the CLI, the app finds your keys, sessions and projects on its own.

**macOS:** the app is not signed with an Apple developer certificate yet, so the first time you open it
macOS says it cannot verify it. Open **System Settings → Privacy & Security** and choose **Open Anyway**
(once). To use `mw` in the Terminal, choose **Settings → About → Add to Terminal** in the app.

## Models

Connect any provider the core supports under **Settings → Providers**: DeepSeek, Anthropic, OpenAI,
Gemini, xAI, Mistral, Groq, Cerebras, Qwen, Kimi, GLM, Meta, MiniMax, Tencent and OpenRouter, each with
your own key. Or run models on your own computer with [Ollama](https://ollama.com): no key, no account,
nothing leaves the machine. Pull a model that uses tools (`ollama pull qwen3:8b`) and it appears while
Ollama runs. The full list is in the core's
[PROVIDERS.md](https://github.com/mindweave-cli/mindweave/blob/main/src/drivers/PROVIDERS.md).

## Building from source

The app builds against the core from a folder next to it, so clone both side by side:

```
git clone https://github.com/mindweave-cli/mindweave.git Mindweave
git clone https://github.com/mindweave-cli/mwcode.git mwcode-desktop
cd Mindweave && npm install && npm run build && cd ..
cd mwcode-desktop && npm install
npm start
```

Packages (each downloads what it needs, Node and Electron included, and checks it against its
publisher's checksum):

| Command | Builds | Run on |
| --- | --- | --- |
| `npm run dist` | the Windows installer and uninstaller | Windows |
| `npm run dist:linux` | the `.deb` and the AppImage | Linux |
| `npm run dist:mac` | the macOS app, zipped and ad-hoc signed | Linux (no Mac needed) |

Tagging a version (`v1.2.3`) builds all of them on GitHub and attaches them to a release, see
[`.github/workflows/release.yml`](.github/workflows/release.yml).

Checks: `npm test` (the app's own tests) and `npm run check:styles` (the stylesheet against
[DESIGN.md](DESIGN.md), which holds the app's design rules). Read DESIGN.md before changing anything
you can see.

## License

[Apache License 2.0](LICENSE), like the core.
