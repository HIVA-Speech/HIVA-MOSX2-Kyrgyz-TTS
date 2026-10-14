// ===== Настройки эксперимента MOS-X2 (кыргызский TTS) =====
// Supabase: Project Settings → API. Сюда — только публичный anon / publishable-ключ:
// он виден всем посетителям, данные защищает RLS (см. supabase/schema.sql).
// Ключ service_role / secret НИКОГДА не кладите в этот файл.
const SUPABASE_URL = "https://xubwvcpnsghvwmmburug.supabase.co";

window.CONFIG = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY: "sb_publishable_lrOkX8r-sFosDFNi0gDJFQ__JipAHbp",

  // Откуда брать аудио. Пути в stimuli.json и ниже — относительно этого адреса.
  // Публичный бакет Supabase Storage (заполняется scripts/make_stimuli.py --upload):
  AUDIO_BASE: `${SUPABASE_URL}/storage/v1/object/public/stimuli/`,
  // или файлы рядом с сайтом (папка audio/ в репозитории): AUDIO_BASE: "audio/",

  // 60 стимулов = 2 пола × 10 категорий × 3 записи.
  // N_LISTS = 3 → каждый слушатель оценивает 20 записей (по одной на ячейку пол×категория).
  // N_LISTS = 1 → каждый слушатель оценивает все 60 (записи ≈ 42 с — это больше часа, не рекомендуется).
  N_LISTS: 3,
  STIMULI_URL: "stimuli.json",

  // Звучание каждой записи ограничено MAX_PLAY_S секундами, последние FADE_S — плавное затухание.
  // null — играть целиком. make_stimuli.py с ffmpeg обрезает файлы так же (--max-seconds / --fade).
  MAX_PLAY_S: 12,
  FADE_S: 1.5,

  // Проверка понимания кыргызского: после каждой записи выбрать прозвучавшую фразу (2–3 слова)
  // из 4 вариантов. Записи берутся из чужих списков, так что в тесте слушатель их не встретит.
  // Фразы генерирует make_stimuli.py из транскриптов. CALIB_N: 0 — выключить.
  CALIB_N: 3,
  CALIB_MIN_CORRECT: 2,

  // Проверка внимания в начале: в каждой записи диктор называет одно число (0–9) по-кыргызски.
  // id совпадают со строками таблицы stimuli. Расширение — то, с которым файлы загружены (.mp3 после ffmpeg).
  CHECK_ITEMS: [
    { id: "check_1", audio: "check/check_1.mp3", answer: 7 },
    { id: "check_2", audio: "check/check_2.mp3", answer: 3 },
    { id: "check_3", audio: "check/check_3.mp3", answer: 9 }
  ],
  CHECK_MIN_CORRECT: 3,   // сколько правильных нужно для допуска
  CHECK_MAX_ATTEMPTS: 2,  // попыток (между ними — совет проверить громкость)

  // Контрольный вопрос в середине теста: «Бардык төрт шкалада 0 тандаңыз». null — выключить.
  // Выключено, пока нет записи; чтобы включить: CATCH_AUDIO: "check/catch.mp3"
  CATCH_AUDIO: null,

  // Пробные примеры (якоря шкалы): натуральная речь и заведомо плохой синтез. Не входят в анализ.
  // Выключено, пока нет записей; чтобы включить:
  // TRAINING: [{ id: "train_natural", audio: "train/natural.mp3" }, { id: "train_low", audio: "train/low.mp3" }],
  TRAINING: [],

  DEFAULT_LANG: "ky"
};
