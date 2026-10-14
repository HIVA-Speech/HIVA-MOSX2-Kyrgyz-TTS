"""Анализ MOS-X2. Выгрузите из Supabase (Table Editor → Export to CSV) в папку data/
(она в .gitignore — персональные данные в репозиторий не попадают):
  data/participants.csv
  data/responses.csv   (или представление responses_full — там же названия категорий и тексты)

pip install -r scripts/requirements.txt
python scripts/analysis.py [папка с CSV, по умолчанию data]
"""
import pathlib, sys
import pandas as pd, numpy as np
from scipy import stats
import statsmodels.formula.api as smf

ITEMS = ["intelligibility", "naturalness", "prosody", "social"]
DATA = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "data")

p = pd.read_csv(DATA / "participants.csv")
r = pd.read_csv(DATA / "responses.csv")

# ---------- 1. Исключения ----------
ok = set(p.loc[p.passed == True, "id"])
catch = r[r.kind == "catch"].set_index("participant_id")
catch_ok = set(catch.index[(catch[ITEMS] <= 1).all(axis=1)])          # просили поставить 0
test = r[(r.kind == "test") & r.participant_id.isin(ok)]
n_done = test.groupby("participant_id").size()
# записей в списке = сколько разных стимулов встречается в этом списке (20 при 10 категориях и N_LISTS=3)
n_list = test.groupby("list_id").stimulus_id.nunique()
complete = set(n_done.index[n_done >= test.groupby("participant_id").list_id.first().map(n_list)])
# «прямая линия»: одинаковые оценки на всех записях по всем шкалам
flat = set(test.groupby("participant_id")[ITEMS].agg(lambda s: s.std()).fillna(0).sum(axis=1).loc[lambda s: s == 0].index)
keep = (ok & complete & (catch_ok if len(catch) else ok)) - flat
# по желанию: только носители
# keep &= set(p.loc[p.native_lang.isin(["ky", "ky_ru"]), "id"])

print(f"Прошли проверку: {len(ok)}, завершили: {len(ok & complete)}, "
      f"контрольный вопрос: {len(catch_ok)}, «прямая линия»: {len(flat)}, в анализе: {len(keep)}")
d = test[test.participant_id.isin(keep)].copy()
d["mosx2"] = d[ITEMS].mean(axis=1)   # общий балл MOS-X2 (0–10) = среднее 4 шкал

# ---------- 2. Надёжность шкалы ----------
k = len(ITEMS); X = d[ITEMS]
alpha = k / (k - 1) * (1 - X.var(ddof=1).sum() / X.sum(axis=1).var(ddof=1))
print(f"Cronbach α (4 шкалы) = {alpha:.3f}")

# ---------- 3. Средние и 95% ДИ ----------
def ci(s):
    m, se = s.mean(), s.std(ddof=1) / np.sqrt(len(s))
    h = se * stats.t.ppf(0.975, len(s) - 1)
    return pd.Series({"n": len(s), "mean": round(m, 2), "ci95": round(h, 2)})

cols = ITEMS + ["mosx2"]
table = d.groupby(["category", "gender"])["mosx2"].apply(ci).unstack()
print("\nMOS-X2 по категориям и полу диктора:\n", table)
print("\nПо шкалам (категория):\n", d.groupby("category")[cols].mean().round(2))
d.groupby(["category", "gender"])[cols].mean().round(3).to_csv(DATA / "mosx2_summary.csv")

# ---------- 4. Смешанная модель: слушатель и стимул как случайные эффекты ----------
d["one"] = 1
m = smf.mixedlm("mosx2 ~ C(category) * C(gender)", d, groups="one",
                vc_formula={"listener": "0 + C(participant_id)", "stimulus": "0 + C(stimulus_id)"}).fit()
print(m.summary())
