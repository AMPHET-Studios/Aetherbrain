# Your Claude and ChatGPT chats inside the brain

Aether Brain can bring your Claude and ChatGPT history in as plain markdown
notes: every chat becomes a moon you can search, link to and read, your Claude
projects become planets with their instructions and knowledge files, and the
pictures ChatGPT made for you become picture moons.

There are two ways in:

- **Import your data export.** This takes your whole history, once, and again
  whenever you like. Works in the desktop app and in the browser.
- **Save a chat live over the AI link.** In a chat, say *"save this chat to my
  brain"* and the AI writes it into your vault. Desktop, with the AI link set up
  ([AI-LINK.md](AI-LINK.md)).

Nothing leaves your computer. The export is read inside the app, and the notes
are written to your own folders.

## 1. Get your export

Neither service lets another app read your chats directly, so you download
them yourself. Each export arrives by email as a download link. It usually
takes a few minutes, and a large history can take longer.

**Claude:** claude.ai → click your name → **Settings** → **Privacy** → **Export
data**. The link in the email downloads a `.zip` with `conversations.json`
(every chat), your projects (their instructions and knowledge files) and some
account files the import ignores.

**ChatGPT:** chatgpt.com → click your name → **Settings** → **Data controls** →
**Export data** → **Confirm export**. The `.zip` holds `conversations.json`
(every chat), the pictures of your chats, `chat.html` and account files the
import ignores.

Keep the `.zip` as it is. You don't need to unzip it.

## 2. Import it

Any of these works:

- press <kbd>i</kbd> and pick the `.zip` file(s): the Claude one, the ChatGPT
  one, or both at once;
- drag the `.zip` onto the Aether Brain window;
- open the palette (<kbd>⌘/Ctrl K</kbd>) and run *Import AI chats (Claude /
  ChatGPT export)…*.

A `conversations.json` or `projects.json` taken out of the zip works too.

Before anything is written, the app asks you to confirm and says what will
happen. For example: *"New: 312 Claude chats, 1,204 ChatGPT chats · Projects: 5
projects with 23 knowledge docs · Pictures: 87 pictures from the chats · Into:
Resources/AI Chats"*. When it is done, a toast has a **Show** button (or press
<kbd>u</kbd>) that flies you to the chats.

## 3. What you get

```
Resources/AI Chats/                     (AI Chats/ when your vault has no Resources folder)
  Claude/
    2026-03-02 Portal lighting.md       one note per chat, named by the day it started
    PORTALz/                            a Claude project: its own planet
      PORTALz (Claude project).md       description, instructions, links to its knowledge and chats
      Knowledge/PORTALz – lore bible.md one note per knowledge file
  ChatGPT/
    2026-03-04 Monolith ideas.md
    Pictures/2026-03-04 Monolith ideas 1.png   pictures ChatGPT made or you sent
    Project 7f3a91c2/…                  chats from a ChatGPT project (see below)
```

If a Claude project has the same name as one of your Aether projects, it goes
into that project's **AI Chats** planet instead (`Projects/PORTALz/AI Chats/`)
and links to it, so the chats orbit the right star.

A chat note looks like this:

```markdown
---
title: 2026-03-02 Portal lighting
tags: [ai-chat, claude]
created: 2026-03-02
updated: 2026-03-04
---
# 2026-03-02 Portal lighting

Claude chat in [[PORTALz (Claude project)]]
Source: <https://claude.ai/chat/5a1f0c1e-…>

## Transcript

*42 messages · 2026-03-02 → 2026-03-04 · claude-sonnet-4*

### You · 2026-03-02 14:05

How should the portal glow?

### Claude · 14:06

Rim light first, then bloom …
```

- **What's included:** the messages as they appear in the chat (for an edited
  message, the version you kept), code blocks, Claude's artifacts and ChatGPT's
  canvases as code blocks, the names of the files you attached (and, for
  Claude, their text), and ChatGPT's pictures with their prompts.
- **What's left out:** hidden reasoning, tool calls and system messages.
- **Everything is searchable:** press <kbd>/</kbd> and type anything you
  remember from a chat.
- **Chat text stays plain text in your brain.** A `[[Gate]]`, `#portal` or
  `- [ ] add bloom` inside a chat is written escaped (`[\[Gate]]`, `\#portal`,
  `- \[ ] add bloom`). It reads the same, but it won't create links, tags or
  to-dos on your Today hub. Code blocks are never touched.
- **Your own notes go above `## Transcript`** (or below the line
  `*— end of transcript —*`). Write your thoughts, `[[links]]` and
  `- [ ] tasks` there, and they count like in any note.

## 4. Import again whenever you like

Export again later and import the new zip. The app recognizes every chat it
brought in before by its `Source:` line, even if you moved or renamed the note.

- New chats are added.
- A chat that got longer has its transcript rewritten, from `## Transcript` to
  the `*— end of transcript —*` line. Everything above and below is yours and
  stays.
- Chats that didn't change are left alone. That includes any edits you made in
  their transcript.
- Nothing is ever overwritten otherwise. A name that is taken gets ` 2`.

## 5. Save a chat live (AI link)

With the AI link set up ([AI-LINK.md](AI-LINK.md)), you can ask Claude or
ChatGPT to *"save this chat to my brain"* or *"remember this conversation in
PORTALz"*. The AI calls `save_chat`:

- the note is named `<today> <title>` and goes to `Resources/AI Chats/Claude`
  (or `ChatGPT`), or to a project's **AI Chats** planet;
- the AI writes a short **Summary** at the top. This part is live, so its
  `[[links]]` and `- [ ] next steps` count like in any of your notes. Then comes
  the transcript, as faithfully as the AI can reproduce it;
- if the AI knows the chat's web address, saving again later updates the same
  note. The summary is replaced, but the transcript only changes when the new
  save has more messages. Importing your export also updates it. A note of
  yours that happens to mention the address is never touched.

An AI usually doesn't know its own chat's web address. A chat saved live
without one gets a second note when you later import your export: the export
has the full transcript, while the live note keeps the AI's summary. Keep both,
or delete the one you don't need.

## Good to know

- **Claude exports have no pictures.** Only the names of the images you
  attached are included (📎). ChatGPT exports do include pictures.
- **Claude exports don't say which chat belongs to which project.** If
  yours does, the chats go into the project's planet. Otherwise they go into
  `Claude/`.
- **ChatGPT exports don't include project names.** Chats from a ChatGPT project
  go into a folder named after the project's id, like `Project 7f3a91c2`. Rename
  the folder in your file manager. The next import finds the chats there and
  puts new ones next to them.
- **Big histories are fine but heavy.** Thousands of chats mean thousands of
  notes that load every time the app starts. If that gets slow, move old chats
  to `Archive/`.
- **Everything is plain markdown.** Obsidian, VS Code or any editor opens the
  same files.
