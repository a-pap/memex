# memex — public mirror of claude-memory architecture

**License:** MIT (code) / CC BY-NC 4.0 (text). Public repo (`a-pap/memex`).

## What this is

Open-source blueprint of the multi-surface Claude memory system. Synced **one-way** from `~/GitHub/claude-memory` (private) via `config/memex-sync*.sh` scripts. This repo is published — anything personal must be stripped before sync.

## Hard rules (зачем CLAUDE.md в этом репо)

1. **Никогда не писать сюда персональные данные.** Не имена, не логины, не клиники, не суммы, не Барселону, не Jay, не PassLocal-конкретику. Single-source-of-truth — `claude-memory/`. Сюда только pattern-level generic.
2. **Никаких секретов** (`cfut_`/`ghp_`/`grn_`/`sk-`/long hex). Pre-commit hook режет, но контроль на уровне рук.
3. **Не запускать sync-скрипты напрямую** — sync делается из `~/GitHub/claude-memory` через `config/memex-sync.sh`. Тут только проверка результата и публикация.
4. **Если в этом репо появился personal-leak** — это инцидент уровня RULES.md §10 (см. claude-memory/RULES.md). Откатить, postmortem в SECURITY.md, добавить regex в guard.

## What lives here

- README.md — public-facing описание архитектуры
- `architecture/` — generic схемы (без хабов с personal-routing)
- Generic примеры конфигов / hooks / template'ов
- Никаких `hubs/*` (private), никаких `STATUS_SNAPSHOT.md` (private)

## Workflow

Изменения архитектуры → правишь в claude-memory → run `~/GitHub/claude-memory/config/memex-sync.sh` → проверяешь diff в `~/GitHub/memex` → коммитишь и пушишь публично.

Reverse-flow (правка в memex напрямую) запрещён — приведёт к расхождению с приватным repo.
