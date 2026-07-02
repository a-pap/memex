# memex — public mirror of claude-memory architecture

**License:** [MIT](LICENSE) (code, templates) / [CC BY-NC 4.0](LICENSE-prose.md) (prose essays). Public repo (`a-pap/memex`).

## What this is

Open-source blueprint of the multi-surface Claude memory system. Narrative docs, templates, examples и tests живут здесь **нативно**; из приватного source-repo переносятся только отдельные санитизированные файлы. This repo is published — anything personal must be stripped before it lands here.

## Hard rules (зачем CLAUDE.md в этом репо)

1. **Никогда не писать сюда персональные данные.** Не имена, не логины, не клиники, не суммы, не локации, не клички питомцев, не названия личных проектов. Single-source-of-truth — `claude-memory/`. Сюда только pattern-level generic.
2. **Никаких секретов** (`cfut_`/`ghp_`/`grn_`/`sk-`/long hex). Pre-commit hook режет, но контроль на уровне рук.
3. **Sync — только точечный и санитизированный.** Отдельные allowlist-файлы переносятся из приватного repo его собственным скриптом (`config/memex-sync.sh` там, не здесь; сюда скрипт не зеркалируется — его strip-паттерны сами содержат то, что он вырезает). Здесь — проверить diff перенесённого файла перед публикацией.
4. **Если в этом репо появился personal-leak** — это инцидент уровня RULES.md §10 (см. claude-memory/RULES.md). Откатить, postmortem в SECURITY.md, добавить regex в guard.

## What lives here

- README.md — public-facing описание архитектуры
- `ARCHITECTURE.md` — generic схемы (без хабов с personal-routing)
- Generic примеры конфигов / hooks / template'ов
- Никаких `hubs/*` (private), никаких `STATUS_SNAPSHOT.md` (private)

## Workflow

- **Narrative-доки и templates правятся здесь, в memex, напрямую** — README, ARCHITECTURE, GIT_AS_RAG и другие essays, `templates/`, `examples/`, `tests/`, workflows. Memex — канонический дом этих файлов; релизы делаются memex-native правками.
- **Из приватного repo прилетают только отдельные санитизированные файлы** — точечный allowlist-перенос его sync-скриптом (см. hard rule 3). После переноса — проверить diff здесь и опубликовать.
- **Расхождения:** для narrative-доков и templates истина — memex; для synced-файлов истина — приватный источник (переносить заново санитайзером, не править копию вручную).
- **Приватные структуры сюда не попадают никогда**: никаких `hubs/*`, никаких `STATUS_SNAPSHOT.md`, никакого персонального routing'а — независимо от того, каким путём файл сюда едет.
