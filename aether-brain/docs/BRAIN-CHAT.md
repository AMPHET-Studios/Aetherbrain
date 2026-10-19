# Chat in the brain

Click the 💬 Chat button in the top bar, or press `q` (desktop app), and a chat opens over the left of the 3D brain. It reads your notes, checks in on how you are, helps you plan, and remembers what you ask it to. Its answers link to your notes: click a link and the camera flies there.

## Setting it up

The first time, the chat shows its settings (⚙ brings them back).

| Who answers | What you need | What leaves your computer |
| --- | --- | --- |
| **Claude** (recommended) | An Anthropic API key from console.anthropic.com → API keys (you pay per use). Pick Claude Opus 5.5 (understands you best), Sonnet 5.5 (faster, half the price) or Haiku 4.5 (fastest). | Your messages and the notes the chat reads to answer go to Anthropic. |
| **Ollama** (on this computer) | [Ollama](https://ollama.com) running, and a model you pulled that can use tools, e.g. `ollama pull llama3.1` or `qwen2.5`. | Nothing. The address must be this computer (`http://127.0.0.1:11434`). |

The app has the chat, but the AI that answers is not inside it: nothing is bundled (a model is about 5 GB). You connect one of the two above. In the chat's settings, the Ollama block looks for Ollama on this computer: it says when Ollama is not running (and how to get it: install it from ollama.com, then `ollama pull qwen3:8b`, about 5 GB), and when it is, it lists the models it has: click one to use it.

The API key is encrypted with your system's keychain (Windows DPAPI, macOS Keychain, the Linux secret service) and stays in the main process; the chat window only ever sees its last four characters. Without a keychain it is kept until the app quits and never written down. **Remove** forgets it.

## What it knows about you

Everything it learns lives in your own notes, in `Me/` (under the first vault folder):

- **About me**: what you asked it to remember, in sections (who you are, how you like to be talked to, what matters, strengths, family, health and routine, work and art, goals, what helps, early warning signs, your care team). It asks before saving anything and tells you what it saved. Edit or delete anything there yourself.
- **Check-ins**: one note per month, one table row per check-in (mood, sleep, energy, stress, medication if you track it, family, a win, a worry).
- **Wellbeing playbook**: the evidence the chat leans on (sleep, movement, stress, an early warning signs plan to fill in, recovery, work and creativity, family, the people you lean on), with its sources.
- **Chats**: each conversation, kept as a note (turn off in ⚙). The transcript is quoted: nothing in it becomes a link, tag or task of your brain.

Each conversation starts from what About me and your last two weeks of check-ins say. Start a **New** chat to pick up what changed since.

## Your Bio notes

The Bio star (`⇧ I`, see [The Bio star](COSMOLOGY.md#the-bio-star)) keeps your notes on sleep, food, meds, exercise, drugs and mental health in a `Bio` folder. They are ordinary notes in your vault, so the chat can find and read them like any other, but nothing reads them for you: a conversation does not start from them the way it starts from About me, and the chat opens one only when your question needs it ("what does my sleep schedule look like?", "plan my day around my workouts").

Who could see them depends on who answers. With **Claude**, whatever the chat reads from them goes to Anthropic with your question; with **Ollama** nothing leaves this computer. If you would rather the chat never read them, `⇧ H` on the Bio star leaves the whole folder out of the brain, and so out of the chat's reach (nothing on disk changes; bring it back in Vault folders, `v`).

The chat keeps to its usual rules with them: it does not diagnose, it never advises starting, stopping, skipping or changing the dose of a medicine, and it takes what you write about drugs without judgment.

## What it does

- Looks things up before answering: search, read notes, today's brief, recent notes, projects.
- Changes notes when you ask: a task, a captured idea, a tick. Tool chips under each answer show what it did (click one with a note to fly there).
- Check-ins: say "check in" (or the **Check in** button, or the palette's *Check in with your brain*). It compares your last week with the weeks before and mentions a shift (sleep down, mood down, stress up, missed medication, a long gap) as a plain fact, then asks.

## Plan my day, and the quiet cards

**Plan my day** (the palette's *Plan my day with your brain*, or the button on an empty chat) asks the chat to look at today's brief, pick at most three things with you and help you start the first. It is for anyone; for someone who finds starting or time hard, the coach leans on each step more. It has two companions: *Check in on my day with your brain* (what is done, re-plan the rest, no guilt) and *Wrap up my day with your brain* (one win, one thing to carry over, a clear stop). They go on in today's conversation, so the evening knows the morning's plan; a conversation left open from another day starts a new one.

A **quiet card** offers each of the three, once a day, under the top bar. No sound, never the keyboard's focus, and no number in it: not a count of what is on, and never of what is late.

| Card | Offers | Shows between |
| --- | --- | --- |
| Good morning | *Plan my day* | 05:00 and 12:00 |
| A check-in | *Check in* | 14:00 and 17:30 |
| Winding down | *Wrap up* | 18:00 and 21:30 |

A card shows when the window is in front, the chat is set up and something is open on today's brief (overdue, or due, scheduled or flagged for today). *In an hour* puts it off; ✕ is *not today*; left alone for two minutes it goes away by itself and comes back in an hour. It waits while the chat is open or answering and while the palette, the cheatsheet or the Boards view is up. Planning the day another way (the palette, the button) counts as taking the card up. Tasks carry dates, not times, so there is no card for "something is due within the hour".

*Turn nudges off* on the card, the checkbox in the chat's ⚙ and the palette's *Nudges* switch the cards off, and on again. They are on until you turn them off.

It is a supportive companion, not a therapist or a doctor. It never diagnoses and never suggests changing a medication; your care team leads. When you mention suicide, self-harm or danger, it stops coaching and stays with you: it asks plainly what is going on and helps you reach the people you chose, and if the danger is now it says to get emergency help and someone next to you. It never pastes hotline numbers unless you ask for one.

## Keys

| Key | |
| --- | --- |
| `q` | Open or close the chat (the 💬 Chat button in the top bar does the same) |
| `Enter` / `Shift+Enter` | Send / new line |
| `Esc` | Clear the message box; on an empty box, close the chat |

Palette: *Chat with your brain* · *New brain chat* · *Check in with your brain* · *Plan my day with your brain* · *Check in on my day with your brain* · *Wrap up my day with your brain* · *Nudges*.

## The same in Claude Desktop

The AI link (`a`) offers the same tools to Claude Desktop, Claude Code and ChatGPT: `about_me`, `remember_about_me`, `check_in`, `my_trends` and `wellbeing_playbook`, next to the note tools. See [AI-LINK.md](AI-LINK.md).
