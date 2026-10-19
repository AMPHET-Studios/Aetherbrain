# Aether Brain for Claude

A plugin that lets Claude work in your **live** [Aether Brain](../../README.md): the notes, projects and pictures the app is showing right now.

- **Send in.** Claude saves a screenshot or a picture file you name straight into your Inbox (`save_image` with a path, up to 40 MB), with your idea written next to it.
- **Look.** Claude can list your pictures, videos and 3D models (`find_pictures`) and see one itself (`get_image`) to describe it, compare it or give feedback.
- **Point.** Claude can fly your 3D view to a note, a folder, a picture or the Today hub (`show_in_brain`).
- Everything the AI link already does: search and read notes, tasks, projects, capture ideas, save the conversation.

## Install

In a terminal (PowerShell on Windows):

```
claude plugin marketplace add YEASTINFECTIONCHEESE/desktop-tutorial
claude plugin install aether-brain@aether-brain
```

Inside an interactive Claude Code session the same two are `/plugin marketplace add YEASTINFECTIONCHEESE/desktop-tutorial` and `/plugin install aether-brain@aether-brain`.

Then open Aether Brain, press `a` and switch **Link on**.

You need Aether Brain 0.10.6 or newer, and [Node.js](https://nodejs.org) 20 or newer on your PATH.

To try it from a copy of the repository without installing: `claude --plugin-dir aether-brain/plugin/aether-brain`.

## How it works

`bin/bridge.mjs` is the MCP server Claude starts. It has no notes of its own: it reads the app's `settings.json` for the link's port and key and passes every message on to `http://127.0.0.1:<port>`. The address is always your own computer, and the key is never printed or sent anywhere else.

It changes exactly one message: `save_image` with a `path`. The app's link refuses file paths (a caller that comes through a tunnel must not name files on your computer), so the bridge, which runs on your computer as you, reads the picture itself with the same checks as the Claude Desktop and Claude Code setups (a whole path, a picture's file name, never a network or device path, a link judged where it leads, bytes that really are a picture, at most 40 MB) and sends its bytes.

When the app is closed or its link is off, Claude is told so and what to do (one tool, `aether_brain_status`). Open the app and switch the link on: the real tools appear in Claude by themselves a few seconds later.

`node bin/bridge.mjs --check` says whether the app answers. `AETHER_SETTINGS` points the bridge at another copy of the app's settings (a file, or the folder that holds it).

## ChatGPT

ChatGPT cannot use a plugin like this: it only calls servers on the internet. It keeps using the AI link through a tunnel, see [docs/AI-LINK.md](../../docs/AI-LINK.md#chatgpt).

More: [docs/AI-LINK.md](../../docs/AI-LINK.md#the-claude-plugin).
