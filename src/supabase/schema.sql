-- Supabase → SQL Editor → выполнить целиком (скрипт можно запускать повторно).
-- Анонимный посетитель может только ДОБАВЛЯТЬ строки; читать данные может лишь владелец проекта.

-- ---------- Стимулы: связь оценок с аудиофайлами ----------
-- Заполняется скриптом scripts/make_stimuli.py --upload (ключ service_role), не из браузера.
-- Названия категорий и тексты хранятся только здесь — слушатели видят лишь коды c01..cNN.
create table if not exists stimuli (
  id             text primary key,          -- m_c01_1, f_c10_3, catch, train_natural, check_1 …
  kind           text not null check (kind in ('test','training','catch','check')),
  gender         text,                       -- male / female
  category       text,                       -- c01..cNN (код, который видит приложение)
  category_name  text,                       -- исходное имя папки: Адабият, Тарых, …
  item           int,                        -- 1..3 — номер текста внутри ячейки
  text           text,                       -- транскрипт (из N.txt рядом с N.wav)
  audio_path     text,                       -- путь в бакете stimuli: m/c01/1.mp3
  duration_s     real,
  source_file    text,                       -- исходный файл: MOS_test_Male/Адабият/1.wav
  updated_at     timestamptz not null default now()
);

create table if not exists participants (
  id                 uuid primary key,
  external_id        text,                 -- ?pid=... из ссылки (Prolific, Toloka и т.п.)
  created_at         timestamptz not null default now(),
  lang               text,
  list_id            int,
  native_lang        text,
  age_group          text,
  sex                text,
  region             text,
  audio_device       text,
  environment        text,
  attention_correct  int,
  attention_attempts int,
  attention_answers  jsonb,
  calib_correct      int,                  -- проверка понимания: верно выбранных фраз
  calib_answers      jsonb,                -- [{id, chosen, correct}] — id записи, выбранная фраза
  passed             boolean not null,
  user_agent         text
);
-- для базы, созданной прежней версией схемы
alter table participants add column if not exists calib_correct int;
alter table participants add column if not exists calib_answers jsonb;

create table if not exists responses (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  participant_id  uuid not null references participants(id),
  stimulus_id     text not null references stimuli(id),
  kind            text not null check (kind in ('test','training','catch')),
  gender          text,
  category        text,
  item            int,
  list_id         int,
  trial_index     int,
  intelligibility smallint not null check (intelligibility between 0 and 10),
  naturalness     smallint not null check (naturalness between 0 and 10),
  prosody         smallint not null check (prosody between 0 and 10),
  social          smallint not null check (social between 0 and 10),
  plays           smallint,
  rt_ms           int,
  unique (participant_id, stimulus_id, kind)   -- защита от повторной отправки
);

create table if not exists feedback (
  participant_id uuid primary key references participants(id),
  comment        text,
  created_at     timestamptz not null default now()
);

alter table stimuli      enable row level security;   -- политик нет → anon не видит
alter table participants enable row level security;
alter table responses    enable row level security;
alter table feedback     enable row level security;

drop policy if exists anon_insert_participants on participants;
drop policy if exists anon_insert_responses    on responses;
drop policy if exists anon_insert_feedback     on feedback;
create policy anon_insert_participants on participants for insert to anon with check (passed is not null);
create policy anon_insert_responses    on responses    for insert to anon with check (true);
create policy anon_insert_feedback     on feedback     for insert to anon with check (true);
-- политик SELECT/UPDATE/DELETE нет → anon не может читать или менять данные
-- (проверка внешних ключей RLS не подчиняется, поэтому stimulus_id проверяется и без доступа к stimuli)

-- Балансировка: новый слушатель получает список, в котором меньше всего прошедших проверку участников
create or replace function next_list(n_lists int)
returns int language sql security definer set search_path = public as $$
  select l
  from generate_series(0, n_lists - 1) as l
  left join (select list_id, count(*) as c from participants where passed group by list_id) p
         on p.list_id = l
  order by coalesce(p.c, 0), random()
  limit 1;
$$;
grant execute on function next_list(int) to anon;

-- Мониторинг (смотреть в Table Editor под своим аккаунтом). Завершившие = оставили экран отзыва.
create or replace view progress with (security_invoker = on) as
select p.list_id,
       count(*) filter (where p.passed)               as passed,
       count(*) filter (where not p.passed)           as failed_check,
       count(f.participant_id)                        as completed
from participants p
left join feedback f on f.participant_id = p.id
group by p.list_id order by p.list_id;

-- Ответы вместе с данными о стимуле — для выгрузки в CSV и анализа
create or replace view responses_full with (security_invoker = on) as
select r.*, s.category_name, s.text, s.audio_path, s.duration_s
from responses r
left join stimuli s on s.id = r.stimulus_id;

revoke all on progress, responses_full from anon, authenticated;

-- ---------- Хранилище аудио ----------
-- Публичный бакет: файлы доступны по ссылке …/storage/v1/object/public/stimuli/<путь>.
-- Загружать может только service_role (скрипт make_stimuli.py); список файлов anon не видит.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('stimuli', 'stimuli', true, 52428800,
        array['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4'])
on conflict (id) do update set public = excluded.public,
                               file_size_limit = excluded.file_size_limit,
                               allowed_mime_types = excluded.allowed_mime_types;
