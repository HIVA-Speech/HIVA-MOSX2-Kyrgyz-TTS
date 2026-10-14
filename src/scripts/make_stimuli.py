"""Собирает stimuli.json из папки с голосами и (по желанию) загружает аудио в Supabase.

Ожидаемая структура (папка voices/ лежит РЯДОМ с репозиторием и в git не попадает):
  voices/MOS_test_Male/<Категория>/1.wav 1.txt 2.wav 2.txt 3.wav 3.txt
  voices/MOS_test_female/<Категория>/…
  voices/check/check_1.wav check_2.wav check_3.wav catch.wav   (необязательно)
  voices/train/natural.wav low.wav                              (необязательно)

Пол определяется по окончанию имени папки (…male / …female). Категориям присваиваются
коды c01..cNN (по алфавиту); соответствие сохраняется в voices/categories.json и при
повторных запусках не меняется. Слушатели видят только коды.

Номер записи внутри ячейки (item = 1..3) определяет список: item 1 → список 0 и т.д.
Желательно, чтобы item k во всех категориях был одним и тем же текстом.

Запуск (из корня репозитория):
  python scripts/make_stimuli.py                      только stimuli.json
  python scripts/make_stimuli.py --upload             + загрузка аудио и таблицы stimuli в Supabase
  python scripts/make_stimuli.py --voices D:/voices   другая папка с голосами

Для --upload нужны SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY (в окружении или в файле .env;
см. .env.example). service_role-ключ секретный: никогда не кладите его в config.js или в git.
Если в PATH есть ffmpeg, файлы перекодируются в MP3 с нормализацией громкости, обрезаются
до --max-seconds с затуханием --fade (то же, что MAX_PLAY_S / FADE_S в config.js, только
заранее — трафик ещё в ~3 раза меньше); без ffmpeg загружаются как есть, а обрезку и
затухание делает браузер (--no-convert — принудительно).

Для проверки понимания (шаг calib) к каждому стимулу добавляется пара/тройка слов из той
части текста, что звучит до затухания, и 3 «ложные» фразы той же длины из других текстов.
"""
import argparse, json, os, pathlib, random, shutil, subprocess, sys, urllib.error, urllib.parse, urllib.request, wave

REPO = pathlib.Path(__file__).resolve().parents[1]
EXT = {".mp3", ".ogg", ".wav", ".m4a"}
MIME = {".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4"}
BUCKET = "stimuli"
# Служебные записи (id совпадают с config.js); строки в stimuli нужны для внешнего ключа responses
EXTRA = [("check", "check_1", "check"), ("check", "check_2", "check"), ("check", "check_3", "check"),
         ("catch", "catch", "check"), ("training", "train_natural", "train"), ("training", "train_low", "train")]


def audio_files(d):
    return sorted((f for f in d.iterdir() if f.suffix.lower() in EXT), key=lambda f: (len(f.stem), f.stem))


def gender_of(name):
    n = name.lower()
    return "female" if n.endswith("female") else "male" if n.endswith("male") else None


def duration(f):
    try:
        with wave.open(str(f)) as w:
            return round(w.getnframes() / w.getframerate(), 2)
    except Exception:
        return None


PUNCT = "«»“”\"'()[].,;:!?…—–-"


def heard_words(text, dur, seconds):
    """Слова, которые звучат в первые `seconds` секунд (по средней скорости речи этого файла)."""
    cps = len(text) / dur if dur else 17.0
    out, pos = [], 0
    for tok in text.split():
        pos += len(tok) + 1
        if seconds and pos > cps * seconds:
            break
        w = tok.strip(PUNCT).lower()
        if w:
            out.append(w)
    return out


def ngram(words, rng, n=None, min_chars=14):
    """Случайная биграмма; если она короче min_chars символов — триграмма."""
    if len(words) < 3:
        return None
    i = rng.randrange(len(words) - 2)
    if n is None:
        n = 2 if len(" ".join(words[i:i + 2])) >= min_chars else 3
    return " ".join(words[i:i + n])


def add_calib(test, heard_s):
    """Для каждого тестового стимула: верная фраза из услышанного и 3 ложные из других текстов."""
    texts = {}  # один текст читают оба голоса → ключ (категория, номер)
    for r in test:
        if r["text"]:
            texts.setdefault((r["category"], r["item"]), heard_words(r["text"], r["duration_s"], heard_s))
    for r in test:
        key = (r["category"], r["item"])
        if key not in texts:
            continue
        rng = random.Random(r["id"])
        phrase = ngram(texts[key], rng)
        full = " " + " ".join(heard_words(r["text"], None, 0)) + " "
        same = [k for k in texts if k[0] == key[0] and k != key]
        other = [k for k in texts if k[0] != key[0]]
        foils = []
        for _ in range(200):
            if len(foils) == 3 or not phrase:
                break
            src = rng.choice(same if not foils and same else other)
            f = ngram(texts[src], rng, n=len(phrase.split()))
            close = f and abs(len(f) - len(phrase)) <= max(5, len(phrase) // 4)  # длина не подсказывает ответ
            if close and f not in foils and f != phrase and f" {f} " not in full:
                foils.append(f)
        if phrase and len(foils) == 3:
            r["calib"] = {"phrase": phrase, "foils": foils}


def load_env():
    env = REPO / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            k, _, v = line.partition("=")
            if k.strip() and not k.lstrip().startswith("#"):
                os.environ.setdefault(k.strip(), v.strip().strip('"'))


def request(method, url, key, data=None, headers=None):
    h = {"apikey": key, "Authorization": f"Bearer {key}", **(headers or {})}
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        sys.exit(f"✗ {method} {url}: {e.code} {e.read().decode(errors='replace')}")


def main():
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8", errors="replace")  # кириллица в консоли Windows
    ap = argparse.ArgumentParser()
    ap.add_argument("--voices", type=pathlib.Path, default=REPO.parent / "voices")
    ap.add_argument("--upload", action="store_true", help="загрузить аудио и таблицу stimuli в Supabase")
    ap.add_argument("--no-convert", action="store_true", help="не перекодировать в MP3")
    ap.add_argument("--lufs", type=float, default=-23, help="целевая громкость при перекодировании")
    ap.add_argument("--max-seconds", type=float, default=12, help="длина звучания (как MAX_PLAY_S в config.js); 0 — без обрезки")
    ap.add_argument("--fade", type=float, default=1.5, help="затухание в конце, с (как FADE_S в config.js)")
    a = ap.parse_args()
    voices = a.voices.resolve()
    if not voices.is_dir():
        sys.exit(f"✗ нет папки {voices}")

    # ---------- коды категорий (стабильные между запусками) ----------
    gender_dirs = {gender_of(d.name): d for d in voices.iterdir() if d.is_dir() and gender_of(d.name)}
    names = sorted({c.name for d in gender_dirs.values() for c in d.iterdir() if c.is_dir() and not c.name.startswith("temp_")})
    map_file = voices / "categories.json"
    cats = json.loads(map_file.read_text(encoding="utf-8")) if map_file.exists() else {}
    for n in names:
        if n not in cats.values():
            cats[f"c{len(cats) + 1:02d}"] = n
    map_file.write_text(json.dumps(cats, ensure_ascii=False, indent=1), encoding="utf-8")
    code = {n: c for c, n in cats.items()}

    # ---------- список стимулов: (row, локальный файл) ----------
    items = []
    for gender in ("male", "female"):
        if gender not in gender_dirs:
            print(f"⚠ нет папки для пола {gender}", file=sys.stderr)
            continue
        for name in names:
            d = gender_dirs[gender] / name
            files = audio_files(d) if d.is_dir() else []
            if len(files) != 3:
                print(f"⚠ {d}: найдено {len(files)} аудиофайлов, ожидалось 3", file=sys.stderr)
            for i, f in enumerate(files, 1):
                txt = f.with_suffix(".txt")
                items.append(({
                    "id": f"{gender[0]}_{code[name]}_{i}", "kind": "test", "gender": gender,
                    "category": code[name], "category_name": name, "item": i,
                    "text": txt.read_text(encoding="utf-8").strip() if txt.exists() else None,
                    "audio_path": f"{gender[0]}/{code[name]}/{i}", "source_file": f.relative_to(voices).as_posix(),
                    "duration_s": duration(f),
                }, f))
    for kind, sid, folder in EXTRA:
        f = next((x for x in sorted((voices / folder).glob(sid.removeprefix("train_") + ".*")) if x.suffix.lower() in EXT), None)
        items.append(({"id": sid, "kind": kind, "gender": None, "category": None, "category_name": None, "item": None,
                       "text": None, "audio_path": f"{folder}/{f.stem}" if f else None,
                       "source_file": f.relative_to(voices).as_posix() if f else None,
                       "duration_s": duration(f) if f else None}, f))
        if not f:
            print(f"⚠ нет {folder}/{sid.removeprefix('train_')}.* — запись {sid} без аудио", file=sys.stderr)

    # ---------- перекодирование ----------
    ffmpeg = None if a.no_convert else shutil.which("ffmpeg")
    if not ffmpeg and not a.no_convert:
        print("⚠ ffmpeg не найден — аудио остаётся в исходном формате (WAV ≈ 10× больше MP3)", file=sys.stderr)
    build = REPO / "build" / "audio"
    filters = f"loudnorm=I={a.lufs}:TP=-2:LRA=11"
    if a.max_seconds:
        filters = f"atrim=end={a.max_seconds},{filters},afade=t=out:st={a.max_seconds - a.fade}:d={a.fade}"
    for row, f in items:
        if not f:
            continue
        out = f
        if ffmpeg:
            out = build / (row["audio_path"] + ".mp3")
            out.parent.mkdir(parents=True, exist_ok=True)
            if not out.exists() or out.stat().st_mtime < f.stat().st_mtime:
                subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", str(f), "-ac", "1",
                                "-af", filters, "-ar", "44100", "-b:a", "128k", str(out)], check=True)
        row["audio_path"] += out.suffix.lower()
        row["_local"] = out

    # ---------- stimuli.json (только то, что нужно браузеру; без названий категорий и текстов) ----------
    test = [r for r, _ in items if r["kind"] == "test"]
    # фраза для проверки — из того, что звучит до затухания, с запасом 1.5 с
    add_calib(test, max(a.max_seconds - a.fade - 1.5, 3) if a.max_seconds else 0)
    pub = [{"id": r["id"], "audio": r["audio_path"], "gender": r["gender"], "category": r["category"], "item": r["item"],
            **({"calib": r.pop("calib")} if "calib" in r else {})} for r in test]
    (REPO / "stimuli.json").write_text(json.dumps(pub, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"stimuli.json: {len(pub)} стимулов ({sum('calib' in p for p in pub)} с фразами для проверки), "
          f"{len(names)} категорий ({map_file.name}: {', '.join(f'{c}={n}' for c, n in cats.items())})")

    if not a.upload:
        return
    load_env()
    url, key = os.environ.get("SUPABASE_URL", "").rstrip("/"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        sys.exit("✗ задайте SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY (окружение или .env)")

    rows = []
    for row, _ in items:
        local = row.pop("_local", None)
        row.setdefault("duration_s", None)
        if local:
            obj = urllib.parse.quote(row["audio_path"])
            request("POST", f"{url}/storage/v1/object/{BUCKET}/{obj}", key, local.read_bytes(),
                    {"Content-Type": MIME[local.suffix.lower()], "x-upsert": "true", "cache-control": "max-age=3600"})
            print(f"  ↑ {row['audio_path']}  ({local.stat().st_size // 1024} KB)")
        rows.append(row)
    request("POST", f"{url}/rest/v1/stimuli?on_conflict=id", key, json.dumps(rows, ensure_ascii=False).encode(),
            {"Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"})
    print(f"✓ загружено {sum(1 for r in rows if r['audio_path'])} файлов в бакет '{BUCKET}', {len(rows)} строк в таблицу stimuli")
    print(f"  AUDIO_BASE для config.js: {url}/storage/v1/object/public/{BUCKET}/")


if __name__ == "__main__":
    main()
