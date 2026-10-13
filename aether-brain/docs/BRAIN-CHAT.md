# Chat in the brain

Press `q` (desktop app) and a chat opens over the left of the 3D brain. It reads your notes, checks in on how you are, helps you plan, and remembers what you ask it to. Its answers link to your notes: click a link and the camera flies there.

## Setting it up

The first time, the chat shows its settings (⚙ brings them back).

| Who answers | What you need | What leaves your computer |
| --- | --- | --- |
| **Claude** (recommended) | An Anthropic API key from console.anthropic.com → API keys (you pay per use). Pick Claude Opus 5.5 (understands you best), Sonnet 5.5 (faster, half the price) or Haiku 4.5 (fastest). | Your messages and the notes the chat reads to answer go to Anthropic. |
| **Ollama** (on this computer) | [Ollama](https://ollama.com) running, and a model you pulled that can use tools, e.g. `ollama pull llama3.1` or `qwen2.5`. | Nothing. The address must be this computer (`http://127.0.0.1:11434`). |

The API key is encrypted with your system's keychain (Windows DPAPI, macOS Keychain, the Linux secret service) and stays in the main process; the chat window only ever sees its last four characters. Without a keychain it is kept until the app quits and never written down. **Remove** forgets it.

## What it knows about you

Everything it learns lives in your own notes, in `Me/` (under the first vault folder):

- **About me**: what you asked it to remember, in sections (who you are, how you like to be talked to, what matters, strengths, family, health and routine, work and art, goals, what helps, early warning signs, your care team). It asks before saving anything and tells you what it saved. Edit or delete anything there yourself.
- **Check-ins**: one note per month, one table row per check-in (mood, sleep, energy, stress, medication if you track it, family, a win, a worry).
- **Wellbeing playbook**: the evidence the chat leans on (sleep, movement, stress, an early warning signs plan to fill in, recovery, work and creativity, family, the people you lean on), with its sources.
- **Chats**: each conversation, kept as a note (turn off in ⚙). The transcript is quoted: nothing in it becomes a link, tag or task of your brain.

Each conversation starts from what About me and your last two weeks of check-ins say. Start a **New** chat to pick up what changed since.

## What it does

- Looks things up before answering: search, read notes, today's brief, recent notes, projects.
- Changes notes when you ask: a task, a captured idea, a tick. Tool chips under each answer show what it did (click one with a note to fly there).
- Check-ins: say "check in" (or the **Check in** button, or the palette's *Check in with your brain*). It compares your last week with the weeks before and mentions a shift (sleep down, mood down, stress up, missed medication, a long gap) as a plain fact, then asks.

It is a supportive companion, not a therapist or a doctor. It never diagnoses and never suggests changing a medication; your care team leads. When you mention suicide, self-harm or danger, it stops coaching and stays with you: it asks plainly what is going on and helps you reach the people you chose, and if the danger is now it says to get emergency help and someone next to you. It never pastes hotline numbers unless you ask for one.

## Keys

| Key | |
| --- | --- |
| `q` | Open or close the chat |
| `Enter` / `Shift+Enter` | Send / new line |
| `Esc` | Clear the message box; on an empty box, close the chat |

Palette: *Chat with your brain* · *New brain chat* · *Check in with your brain*.

## The same in Claude Desktop

The AI link (`a`) offers the same tools to Claude Desktop, Claude Code and ChatGPT: `about_me`, `remember_about_me`, `check_in`, `my_trends` and `wellbeing_playbook`, next to the note tools. See [AI-LINK.md](AI-LINK.md).
