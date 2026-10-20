# controlled run（HUMAN-010）の SQL — Staging だけ

対象の demo は `efb4bdb2-5fb8-4575-b2e1-76217a832485` だけ。Production では使わない。

| file | 種類 | 誰が |
|---|---|---|
| `snapshot.sql` | 読むだけ | Claude（または人）。状態・attempts・job・profile の md5・outreach・queue の数 |
| `restore-gen.sql` | 読むだけ | 人（Supabase SQL editor）。結果の 1 行が「元に戻す update」。**reset の前に**実行し、出力を自分の PC に保存する（profile の中身を含むので git・会話には貼らない） |
| `reset.sql` | **書き込み（承認が要る）** | 人。ready → pending。他に pending / processing の demo があれば 0 行で何もしない |
| `after.sql` | 読むだけ | Claude。run の後の確認 |

- 戻す update（restore-gen の出力）は `processing` の間は 0 行で何もしない（走っている job を壊さない）。`design_attempts` も元の値に戻る
- claim の後で止まったときの job id を条件にした戻し方は `docs/operations/design-worker-cycle.md` §6.2
- 2026-10-20 にローカルの Postgres 16（同じ check 制約の縮小 schema）で確かめた: reset 1 行 → 2 回目 0 行、restore で md5 と review・job id・attempts が一致、他の pending があると reset 0 行、processing のとき restore 0 行。引用符・`$f$`・backslash・日本語を含む profile でも戻る
