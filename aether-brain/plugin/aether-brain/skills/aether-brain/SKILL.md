---
name: aether-brain
description: Work in the user's live Aether Brain, their local 3D second brain of markdown notes, projects, tasks and pictures. Use when they ask you to save, send or remember something in their brain, keep a picture or screenshot, look at or give feedback on the pictures in it, show them something in it, or plan their day from it.
---

# Aether Brain

Aether Brain is the user's second brain: plain markdown notes in folders on their own computer, shown as a 3D space (a folder is a star, a big file a planet, a picture a moon). You reach the running app through this plugin's tools. Everything stays on their computer.

## If the tools are missing or a call fails

Call `aether_brain_status`. It says whether the app is running with its AI link on, and what the user has to do (open Aether Brain, press `a`, switch Link on). Tell them that in plain words. Nothing needs restarting: the real tools appear as soon as the app answers. Do not guess at notes you could not read.

## Start by looking

- `vault_overview` first, to see the folders and projects. `daily_brief` for "what should I do today".
- `search_notes`, then `read_note`. Name a note by its title, alias, id or vault path; an ambiguous title returns the paths to use.

## Sending things in

- An idea or a thought: `capture` (it goes to the Inbox). A proper note: `create_note`, with `[[wikilinks]]` to the notes it belongs with. A task: `add_task` on its project.
- A picture or screenshot that is a file on this computer: `save_image` with `path` (the whole path). Add `title` or `text` to get an Inbox note that shows the picture, and write the idea in the user's own words. A picture is never replaced: a taken name gets a number.
- A picture that only exists in the chat (pasted or attached) has no file for you to read. Ask for its path, or ask them to drop it onto the Aether Brain window. Do not type out base64 for anything but a tiny icon.
- Say where it went (the reply names the path). New notes go to the Inbox unless you give a folder, and a taken name gets a number: nothing is overwritten. Prefer small edits (`append_to_note`, `edit_note`) over rewriting a note, and keep the user's own words. No tool deletes a note.

## Projects and tasks

A project is a note with `type: project` and a `## To do` list of `- [ ]` lines. `get_project` and `read_note` list its tasks with line numbers; `set_task_done`, `edit_task` and `delete_task` take that line or the task's text (give both: lines move when a task above is added or deleted). `daily_brief` is the user's Today: what is overdue, due or scheduled today, and the next task of each active project. A project's home folder is a star and the folders inside it are planets (`create_folder`).

When the user asks you to save or remember this conversation, call `save_chat`: a title, a short summary with next steps as tasks, and the messages as faithfully as you can.

## Looking at pictures

- `find_pictures` lists the pictures, videos and 3D models by words in their path (`query`), optionally inside one `folder`.
- `get_image` returns the picture itself (a video gives a still frame, a 3D model a still). Look at it, then say what you actually see: composition, colour, what works, what to change. Ask for a smaller `max_px` (256 to 384) when comparing several pictures, a larger one (up to 1024) to check detail.
- The reply names the notes that show the picture. Read them before giving feedback: they hold the user's intent.

## Showing things

`show_in_brain` flies their 3D view to a note, a folder, a picture or the Today hub, and selects it. Use it when you made or found something they should see, once, not after every step: it moves their camera. It waits if they are typing in a note, and the Aether Brain window has to be open.

## Personal parts of the brain

The Bio star (the `Bio` folder: sleep, food, meds, exercise, substances, mental health) is the user's private log. Read or add to it only when they ask. `about_me`, `check_in` and `wellbeing_playbook` exist for how they are doing: ask before remembering anything personal, save it in their words and say what you saved. You are a supportive companion, not a clinician: never diagnose or advise changing medication; their care team leads.

## ChatGPT

This plugin is for Claude. ChatGPT can only reach Aether Brain through the AI link's tunnel (see `aether-brain/docs/AI-LINK.md`), where it has the same notes and `save_image` with ChatGPT's own attachments, but no file paths.
