# MOS-X2 listening test for Kyrgyz TTS

A browser-based listening test that rates synthesized Kyrgyz speech with the **MOS-X2** questionnaire (Lewis, 2018). Each recording gets four 0–10 ratings: intelligibility, naturalness, prosody and overall impression. The interface is in Kyrgyz and Russian. The site is static and hosted on **GitHub Pages**. Responses go to **Supabase Postgres**, and the audio is served from a **Supabase Storage** bucket.

Russian design notes: [README.ru.md](README.ru.md).

## Experiment design

| | |
|---|---|
| Stimuli | 60 = 2 speaker voices (male, female) × 10 text categories × 3 texts |
| Categories | coded `c01`…`c10`; listeners never see the category names |
| Per listener | 20 recordings, one per voice × category cell (`N_LISTS = 3`, balanced A/B/C lists) |
| Playback | first **12 s** of each recording, the last 1.5 s fading out (`MAX_PLAY_S`, `FADE_S`); must play to the end, no seeking |
| Screening | 1) spoken-digit audio check (3/3, 2 attempts); 2) **Kyrgyz comprehension check**: 3 clips, after each one pick the 2–3-word phrase that was spoken out of 4 options (≥ 2/3 correct) |
| Quality checks | 2 training anchors, a mid-test catch trial ("rate everything 0") |
| Exclusions (analysis) | failed screening, incomplete, failed catch trial, straight-lining |
| Target sample | ≥ 20 ratings per stimulus, so ≥ 60 completers; recruit about 80 |

A new participant is assigned to the list with the fewest completers (`next_list()` in SQL). Trial order is shuffled so that no two consecutive trials share a category and no three share a voice.

**How the comprehension check works.** `make_stimuli.py` estimates each file's speech rate (transcript length ÷ duration) and takes the words spoken in roughly the first 9 s, safely before the fade.

- **Correct option:** a random bigram from those words, or a trigram if the bigram is shorter than 14 characters.
- **Foils:** 3 phrases with the same number of words and similar length. One comes from another text in the same category, two from other categories, and none occurs anywhere in the target text.
- **Which clips:** the browser picks clips from the *other* lists, so participants never rate a recording they already heard in the check.
- **What is saved:** the chosen phrases go to `participants.calib_answers`.

Because the clips are TTS output, a hard-to-understand system can also make listeners fail. Read the failure rate with that in mind.

## Where the data lives

Use **Supabase**. The app is already built on it, and it keeps the ratings and the voice files in one project:

```
 GitHub Pages (static site)                    Supabase project
 ┌──────────────────────────┐   insert only   ┌───────────────────────────────────────┐
 │ index.html / app.js       │ ─────────────▶ │ Postgres                               │
 │ stimuli.json (codes only) │   (anon key,   │  participants ─┐                       │
 └────────────┬─────────────┘    RLS)         │  responses ────┼─ stimulus_id ─┐       │
              │                               │  feedback ─────┘               ▼       │
              │  GET audio (public URL)       │  stimuli  (id, category_name, text,    │
              └─────────────────────────────▶ │            audio_path, duration) ─┐    │
                                              │ Storage bucket "stimuli"          │    │
                                              │  m/c01/1.mp3 … f/c10/3.mp3  ◀─────┘    │
                                              │  check/…  train/…                      │
                                              └───────────────────────────────────────┘
```

**How each rating links to its voice file.** `scripts/make_stimuli.py` gives every recording one ID and uses it everywhere:

| Source file (`../voices`, not in git) | Stimulus ID | Storage object | Row in `stimuli` |
|---|---|---|---|
| `MOS_test_Male/Адабият/1.wav` + `1.txt` | `m_c01_1` | `stimuli/m/c01/1.mp3` | `category_name = Адабият`, `text = …`, `duration_s = 41.2` |

- `responses.stimulus_id` is a foreign key to `stimuli.id`, so every rating points to exactly one stored audio file and its transcript.
- The `responses_full` view joins the two tables. Export it to get ratings with category names, texts and audio paths in one CSV.

**Why Supabase and not Firebase**

| | Supabase (free plan) | Firebase |
|---|---|---|
| Ratings | Postgres: SQL, foreign keys, CSV export | Firestore documents, no joins; export needs a script |
| Audio | Storage, 1 GB, public URLs, 50 MB per file | Cloud Storage for Firebase now requires the paid Blaze plan for new buckets |
| Access rules | Row-level security: visitors can insert, only you can read | Security rules: `allow create: if true; allow read: if false` |
| Balanced lists | `next_list()` SQL function | needs a counter document and a transaction |

**Free-plan limits to watch.** Egress is 5 GB per month. The originals last about 42 s, but only the first 12 s are played:

- With ffmpeg, the script cuts each file to 12 s with the same fade and converts it to 128 kbps MP3, about 0.2 MB. One listener then uses about 5 MB, including the check clips, and 80 listeners about 0.4 GB.
- Without ffmpeg, the full 24-bit WAVs are uploaded and the browser does the cutting, but it still downloads whole files. That is about 65 MB per listener and about 5 GB for 80 listeners, which is right at the cap.

So **install ffmpeg before uploading**. Free projects also pause after a week with no activity, so keep the project active while you collect data.

If you must use Firebase, keep the same IDs and paths. Store the files under `stimuli/m/c01/1.mp3`, use collections `participants`, `responses` and `feedback` with `stimulus_id` fields, and point `AUDIO_BASE` to the bucket's public URL.

## Repository layout

```
index.html            page + styles
app.js                consent → demographics → audio check → comprehension check → training → 20 ratings → feedback
config.js             Supabase URL + anon key, AUDIO_BASE, experiment parameters
i18n.js               UI texts (ky / ru)
stimuli.json          stimulus list served to the browser (generated: codes + comprehension-check phrases)
supabase/schema.sql   tables, RLS policies, list balancing, storage bucket, views
scripts/make_stimuli.py   voices → stimuli.json (+ MP3 conversion, upload to Storage, stimuli table)
scripts/analysis.py       exclusions, Cronbach's α, means ± 95 % CI, mixed model
scripts/requirements.txt  Python packages for analysis
```

These are kept **outside git** (see `.gitignore`):

- `../voices/`: the original WAVs and transcripts, plus `categories.json`, the code → name mapping.
- `.env`: the service key.
- `data/`: exported participant data.
- `build/`: converted MP3s.

## Setup

1. **Supabase.** Create a project. Open the SQL Editor, paste [supabase/schema.sql](supabase/schema.sql) and run it. This creates the tables, the policies and the public `stimuli` bucket.
2. **Keys.**
   - Copy `.env.example` to `.env` and fill in `SUPABASE_URL` and the `service_role` (secret) key. Only the upload script uses this file.
   - Put the same URL and the **anon / publishable** key in [config.js](config.js). That key is public by design.
3. **Audio.** Put the extra recordings next to the category folders: `voices/check/check_1..3.wav`, `voices/check/catch.wav`, `voices/train/natural.wav` and `voices/train/low.wav`. Install [ffmpeg](https://ffmpeg.org/download.html), then run from the repository root:
   ```
   python scripts/make_stimuli.py --upload
   ```
   This writes `stimuli.json`, uploads the audio to the bucket and fills the `stimuli` table. Commit the new `stimuli.json`. If you upload WAV without ffmpeg, change the `.mp3` extensions in `config.js` to `.wav`.
4. **GitHub Pages.** Push the repository. Go to Settings → Pages → Deploy from a branch, choose `main` and `/ (root)`. The site goes live at `https://<user>.github.io/<repo>/`. Adding `?pid=XYZ` to the link stores an external participant ID (for Prolific, Toloka or payments).
5. **Pilot** with 3–5 people. Check the completion time, that the scales are clear, and that rows appear in the tables. Then delete the pilot rows.
6. **Monitor** with the `progress` view (passed, failed check, completed per list).

## Analysis

Export `participants` and `responses` (or `responses_full`) as CSV into `data/`, then run:

```
pip install -r scripts/requirements.txt
python scripts/analysis.py data
```

The script prints exclusion counts, Cronbach's α, MOS-X2 means with 95 % CIs per category × voice, and a mixed model with listener and stimulus as random effects. It also writes `data/mosx2_summary.csv`.

## Privacy and security

- Visitors use the anon key and can only **insert** rows. Row-level security blocks reading, editing and deleting, and the `stimuli` table (category names, texts) is not readable at all.
- The `service_role` key bypasses all of these rules. It must never appear in `config.js` or in a commit.
- No names or e-mails are collected. Participant data must not be committed to this repository.

## License

The code is under the MIT license (see [LICENSE](LICENSE)). The audio, transcripts and participant data are not included or licensed here.

Questionnaire: Lewis, J. R. (2018), MOS-X2. Check the full citation and the exact item wording against the original paper before you publish.
