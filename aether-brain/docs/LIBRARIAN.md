# The librarian

Press `⇧ L` (desktop app) and the librarian copies every picture of a folder or a whole drive into one library, sorted by **type**, **genre** and **year**, tagged by **taste** (colour mood), and linked into the brain: the library becomes a ★ star whose planets are its types, and `⇧ G` on it opens every picture around it.

It **copies**. Nothing in the source is moved, renamed, changed or deleted, ever.

## How it goes

1. **From → to.** By default `D:\` → `F:\MASTERIMAGES` on Windows (your Pictures folder → `~/MASTERIMAGES` elsewhere). Type a path or press **Choose…**.
2. **Vision model (once, optional).** **Download** fetches CLIP ViT-B/32 (OpenAI's model, 8-bit, about 150 MB) from Hugging Face into the app's data folder. After that it runs on this computer only. Without it the librarian still sorts, by each file's own data, its name, its folders and its colours.
3. **Look through.** It walks the source, reads each picture's header, looks at each picture (colours; with the model, what it shows), finds duplicates, and shows the **plan**: how many pictures, where each type and genre goes, sample thumbnails, taste, years, free space. Nothing is copied yet.
4. **Copy.** One button. Progress shows the time left; **Stop** keeps what is copied, and the next run picks up the rest.
5. **Fly to it.** When the library is inside the brain's folders, **Fly to MASTERIMAGES** selects its hub. When it is not, **Show MASTERIMAGES in the brain** adds the folder as a vault folder first.

## Where a picture goes

`<library>/<Type>/<Genre>/<Year>/<file>` (Documents and Other have no genre level: `<Type>/<Year>/<file>`).

| | Decided by |
| --- | --- |
| **Type** | Photos · Screenshots · Concept Art · Renders · Sketches · AI Generated · Textures · Memes & Web · Documents · Other. Sure signs first: an image generator's settings or a C2PA "made by AI" mark (AI Generated), a screenshot's file name, a texture map's suffix (`_normal`, `_roughness` …), a camera in the EXIF or a camera file name (`IMG_…`, `PXL_…`, `DCIM/`). Then the vision model when it is confident (60 %+), then folder names and the program that saved it (`Blender`, `Photoshop` …), then the model at 40 %+, else Other. AI Generated comes from metadata and names only: a picture does not show reliably whether a generator made it. |
| **Genre** | Words in its folders and name first (`Portals/` → Ancient High-Tech, `cyberpunk refs/` → Cyberpunk), then the vision model (35 %+), else `Unsorted`. Art: Ancient High-Tech, Sci-Fi, Cyberpunk, Fantasy, Dark Fantasy, Horror, Post-Apocalyptic, Steampunk, Nature, Urban, Historical, Stylized & Anime, Abstract. Photos: Family & Friends, Portraits, Pets & Animals, Nature & Landscapes, City & Architecture, Travel, Food, Events & Parties, Vehicles, Art & Museums, Everyday. Screenshots, textures and web graphics have their own. |
| **Year** | The photo's own date (EXIF), else a date in its name (`IMG_20240612…`, `Screenshot 2024-06-12…`), else the file's date, else `Undated`. The copy keeps the original's modified date. |
| **Taste** | From the picture's colours: dark & moody, bright, monochrome, muted, vibrant, warm, cool, high contrast. Each taste gets a note gathering its pictures (the files stay in their type folders). |
| **Subjects** | With the model, art and photos get subject tags (characters, creatures, environments, architecture, vehicles, props, portraits, animals, interiors). |

What stays out: icons and cache thumbnails (under 160 px or 4 KB; a checkbox keeps them), files named like pictures that are not, installed games and programs, and the same folders the brain skips (Windows, Program Files, AppData, build and cache folders, hidden folders). The library folder itself is never sorted into itself.

## Duplicates and second runs

Pictures with the same bytes are copied once (only files of the same size are compared, by SHA-256). The library's `.aether-library.json` remembers what came from where, so running it again copies only what is new. A picture you delete from the library stays out on later runs. Two different pictures with the same name in one folder become `gate.png` and `gate (2).png`; nothing is ever copied over a file that is there.

## The notes

| Note | What it holds |
| --- | --- |
| `MASTERIMAGES/MASTERIMAGES.md` | The hub, `type: project` (so the library is a star): counts per type and genre, taste, a table of years. |
| `<Type>/<Type>.md` | Its genres, taste, subjects, years, its newest 24 pictures. |
| `<Type>/<Genre>/<Genre>.md` | The same for one genre, linked up to its type. |
| `Taste/<Taste>.md` | Pictures of that colour mood, by type. |

Each note has a `## Library` section the librarian rewrites on every run; everything else in the note is yours and stays.

## Privacy

The vision helper is a hidden, sandboxed window with **no network at all**: its session refuses every request except its own page, the ONNX runtime shipped with the app, and the model files on disk. The only download is the model, once, when you press **Download**, from `huggingface.co` (it goes through your system's proxy settings). What the helper saw in each picture is kept in the app's data folder (`library-looks.json`) so a second run is fast.

## Keys

| Key | |
| --- | --- |
| `⇧ L` | Open or close the librarian |
| `Enter` | The focused button (Look through, Copy, Fly to it) |
| `Tab` | Move between its controls |
| `Esc` | Close it (a running job keeps going; its progress is there when you open it again) |

Palette: *Librarian: copy and sort every picture of a drive into one library…*
