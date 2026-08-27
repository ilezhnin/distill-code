# Distill Code — архитектура волны кондуктора

Status: reference (описание того, что есть в коде, а не плана работ)

Updated: 2026-08-27 (re-baseline P1: документ описывал удалённый код как
реальность в шести местах и предписывался к чтению первым)

**План работ живёт не здесь.** Единственный источник планирования —
`../PLAN.md` рядом с репозиторием (59 пунктов, 11 этапов), бухгалтерия
сделанного — `../DONE.md` там же. Этот файл отвечает на один вопрос: как
устроена волна сегодня, чтобы новый исполнитель не изобретал заново и не
искал по коду то, что уже описано.

---

## 1. Что такое волна

Conductor — тип чата. Сообщение оператора уходит в модель обычным ACP-сендом
(`features/chat/lib/sendCore.ts`) с протокольным системным промптом
(`composeConductorSystemPrompt` из `features/conductor/wavePrompts.ts`).
Кондуктор отвечает одним из двух: обычным текстом (прямой ответ) или планом
волны — фенсом `distill-wave` с JSON.

```distill-wave
{"steps":[{"role":"researcher","subtask":"…","access":[],"label":"…","model":"…"}]}
```

`role` — id роли worker-слоя из `roleCatalog.ts`; `label` и `model`
необязательны. Не более 5 шагов (`MAX_WAVE_STEPS`). Парс строгий и
трёхзначный (`distillWave.ts`): фенса нет →
обычный ответ; фенс валиден → волна; фенс битый → видимая ошибка с
перечисленной причиной, не спавнится ничего. Regex-fallback и второй путь
спавна удалены осознанно (D1/Q2 в `../PLAN.md` §3) — восстанавливать их
нельзя.

`access` бинарен: `[]` — шаг стартует сразу, параллельно; `"all"` — шаг ждёт
терминальности всех предыдущих шагов волны и получает их JSON-отчёты в своём
первом сообщении. Наверх и вбок идут **отчёты, никогда транскрипты** (D2).

`model` — единственный легальный оверрайд модели шага (4a,
`waveStepTarget.ts`). Недоступная модель — отказ всего плана с причиной
`step-model-unavailable`, а не тихая подмена на доступную (D5).

---

## 2. Движок

Чистая логика решений — `waveEngine.ts` (`admitWavePlan`, `advanceWave`):
ничего не спавнит, ничего не пишет. Эффектная оболочка — `waveRunner.ts`.
Детект плана в сообщениях кондуктора — `waveDetection.ts`, глобальный цикл —
`useConductorGraphSync.ts` / `ConductorGraphSync.tsx` (работает при закрытом
чате).

Фазы шага (`WAVE_STEP_PHASES` в `waveEngine.ts` — единственный источник
правды, персист-гард `waveStore.ts` читает этот же массив):
`pending` → `spawning` → `spawned`, плюс терминальный `failed` (спавн бросил;
авторетрая нет, и последующие шаги не ждут его вечно).

Фазы волны (`WAVE_PHASES`): `running` → `digestPending` →
`dispatchingDigest` → `awaitingVerdict` → `accepted` | `revised` |
`needsOperator`. Спавнит только `running`.

Состояние волны (`WaveState`) несёт `rootRequestId` — идентичность корневого
запроса оператора, наследуемую ревизиями без изменений; именно из-за неё кап
ревизий считается на запрос, а не на волну. Плюс `revisionCount`,
`digestAttempt`, `carriedReports` (отчёты предыдущей волны того же корня),
`verdictIssue`, и две отметки git-грязи (`gitDirtyAtAdmission`,
`gitDirtyAtDigest`, `waveGitProbe.ts`) — единственный факт в дайджесте,
который не сочинила модель.

Хранилища: граф сессий — `conductorGraphStore.ts` (localStorage
`goose:conductor-graph`), волны — `waveStore.ts` (`goose:conductor-waves`),
телеметрия — `waveTelemetryStore.ts`. Переезд на файлы `.distill` запланирован
(P24 в `../PLAN.md`), в localStorage запись может тихо отказать.

Узел графа (`types.ts`, `SessionNode`) несёт `managedBy: "ui" | "wave" |
"agent-cli"`: движок волн трогает только `"wave"`. Wave-дети дополнительно
несут `waveId`, `stepIndex` и `anchorMessageId = planMessageId` — последнее
и есть ключ per-message футера чипов.

---

## 3. Дайджест и вердикт (замкнутый цикл D4)

Терминальный ребёнок публикует отчёт фенсом `distill-report`
(`orchestratorReport.ts`); статус отчёта — `completed` / `failed` /
`cancelled` / `blocked`, где `blocked` — не исход рана, а заявление воркера,
что шаг сделать нельзя, и результат не выдуман (`StructuredReport` в
`types.ts`).

Когда все шаги терминальны, `waveDigest.ts` собирает дайджест, а
`digestDelivery.ts` / `waveLifecycle.ts` доставляют его кондуктору **реальным
user-сообщением** через berdctl-seam (`session send`, `if_running=queue`,
`digestPublisher.ts`). Синтетическая публикация итога, которую родитель читал
и продолжал спать, удалена в 3a вместе со своим модулем.

Следующий устоявшийся ответ кондуктора читается как вердикт
(`distillVerdict.ts`), фенс `distill-verdict`:

```distill-verdict
{"verdict":"accept","note":"…"}
```

Токены — ровно три: `accept`, `revise`, `needs-operator`
(`VERDICT_TOKENS`). `revise` требует `distill-wave` фенса в том же сообщении;
голый wave-фенс без вердикт-фенса читается как `revise`; `accept` или
`needs-operator` вместе с wave-фенсом — ошибка парса. Нет ни одного фенса →
`needs-operator` (Q5). Битый вердикт не ретраится автоматически: ретрай —
только ручной кнопкой, и повторный дайджест цитирует `verdictIssue`, чтобы не
задавать тот же вопрос дважды.

Кап — **2 ревизии на корневой запрос**, проверяется в приложении, а не в
промпте. Кап считается на план-сообщение: новое сообщение оператора после
`needsOperator` возвращает полный бюджет (нотис об этом — P14).

---

## 4. ACL

`spawnAcl.ts` + `aclDefaults.ts`: кто какой слой ролей может спавнить
(`DEFAULT_SPAWNS_BY_ROLE`, переопределяется персоной) и кто может писать в
долговременную память (`DEFAULT_MEMORY_WRITE_BY_ROLE`, три честных состояния
`allowed` / `denied` / `grant-required`). Энфорс — в
`spawnConductorChildSession` (`spawnOrchestrator.ts`); строка политики
генерируется в промпт из того же ACL (`formatSpawnPolicyPrompt`), так что
модель и харнесс говорят одно и то же.

Известная дыра: фоновый путь `berdctl session create` / `fork` анонимен —
wire-протокол не несёт identity вызывающего, и агентские сессии между собой
неразличимы. Держит их сегодня только строка промпта. Закрытие — P42.

---

## 5. Память

Фенс `distill-memory` (`features/memory/lib/memoryFence.ts`) — тот же канал,
что `distill-todo`, потому что он одинаково работает на goose и на мостах
Claude / Grok / Codex. До 5 записей за ход. Сканер смотрит хвост последних
сообщений (`memoryAgentScan.ts`), стор — `memoryStore.ts`, файл в корне
`.distill`. Врезка в промпт — `<memory>`-блок,
глобальные факты первыми, проектные вторыми, бюджет 4 000 символов по
recency (`memoryPrompt.ts`); пустой блок не выводится вовсе. Право записи —
из ACL (`memoryWriteAccess.ts`).

Корень `.distill` — `src-tauri/src/services/distill_root.rs`: приоритет
`DISTILL_ROOT` → файл-указатель в OS-config → `~/.distill`. Проектных
оверрайдов и версионности пока нет (этап 4 в `../PLAN.md`).

---

## 6. Что видно оператору

Чипы детей — `ConductorAgentFooter` / `waveFooterChips.ts`, под тем
сообщением, чей id равен `anchorMessageId`. Дети скрыты из сайдбара, поиска и
свитчера (`sessionVisibility.ts`). Harness-субагенты (Goose delegate/load,
Claude Code Task/Agent, Codex spawn_agent) классифицируются в
`features/chat/lib/subagentToolCalls.ts` и проецируются чипами в любом чате —
прозрачность есть свойство любого чата, автоповедение (волны) — только у
conductor-типа.

Никаких молчаливых подмен (D5): явная модель шага, суффикс на чипе, бейдж
«кондуктор исполняет сам» при мутирующем инструменте
(`conductorSelfExecution.ts`), отказ вместо тихого даунгрейда.

---

## 7. Чего здесь нет и почему

Полный список отказов — `../PLAN.md` §6. Коротко: произвольные DAG между
шагами, fine-grained access-списки, MoA-агрегация, своё обучение кондуктора,
репутационные приоры моделей, безлимитные ревизии, авторетраи любого рода,
regex-fallback плана, второй session manager ради `berdctl --parent`,
жёсткий harness-запрет инструментов кондуктору. Каждый пункт оплачен спором
или измерением; переоткрывать без новых данных запрещено.

## 8. Ссылки

- `../PLAN.md` — единственный план работ, устоявшиеся решения, список отказов.
- `../DONE.md` — что уже сделано, каким коммитом и проверено ли живьём.
- `LAWS/` и `PRODUCT.md` — продуктовые инварианты репозитория.
