# Distill Code — production-first implementation plan

Status: active

Updated: 2026-08-23 (re-baseline: первый conductor-срез отгружен на main 2026-08-21,
commit `3dc2fa78`; план объединяет трек «волны кондуктора» из `../conductor_handoff.md`
и трек «прозрачность бригад» из `../combined_plan.md`; развилки Q2/Q3/Q5/Q6 утверждены
оператором 2026-08-23 и в задачах не пересматриваются)

## Рабочий принцип

Сначала появляется работающий продукт, который оператор может открыть и
попробовать. Тесты, доказательные спайки, отчёты о спайках и подробная
документация не являются входным условием разработки.

Первый агент должен сразу менять продукт и закончить работу видимым сквозным
сценарием. Нельзя завершать задачу исследованием, планом, набором типов,
макетом, тестами без интерфейса или документом о том, что когда-нибудь нужно
реализовать. Исключения указаны явно (пункт 1b — библиотека с тестами без
прошивки в рантайм; пункт 0 — контракты).

## Реальность на 2026-08-23 (что уже в main)

- Conductor — тип чата; на каждое сообщение оператора UI-эвристика
  (`planOrchestratorTasks` regex → `useConductorAutoSpawn`) спавнит пары
  оркестратор+воркер. **Модель кондуктор не вызывает**: `sendCore.ts` обрывает
  диспатч для graph-координаторов (`isGraphCoordinatorSession`).
- Граф — `features/conductor/conductorGraphStore.ts`, localStorage
  `goose:conductor-graph`. Чипы детей — `ConductorAgentFooter`, только под
  последним сообщением, только в conductor/orchestrator-чатах.
- Отчёты — `distill-report` fence; синтетическая публикация итога —
  `publishCompletedTurns` в `useConductorGraphSync.ts`.
- Дети скрыты из сайдбара/поиска/свитчера (`sessionVisibility.ts`).
- Harness-субагенты (Goose delegate/load, Claude Code Task/Agent, Codex
  spawn_agent…) классифицируются в `features/chat/lib/subagentToolCalls.ts`, но
  видны только как строки инструментов в шагах.

Авто-спавн — временная конструкция: удаляется в пункте 2a.

## Зафиксированные решения (не пересматривать)

1. **D1**: план кондуктора — fenced `distill-wave` JSON
   `{"steps":[{"role","subtask","access":[]|"all","model"?}]}`, ≤5 шагов,
   строгий парс.
2. **D2**: первое сообщение ребёнка = роль + сабтаск + (при `"all"`) JSON-отчёты
   завершённых предыдущих шагов. Отчёты, никогда не транскрипты.
3. **D3**: гейт сложности — простое → прямой ответ; волна только для
   многошагового (волна из 1 шага = «один ребёнок»).
4. **D4**: замкнутый цикл — digest конвертов кондуктору → ровно одно из:
   accept / одна ревизионная волна / needsOperator; кап 2 ревизии на корень,
   в приложении.
5. **D5**: per-step model — явное поле, видимое в UI; дефолт — наследование;
   тихий даунгрейд запрещён.
6. **Q2 (решено)**: strict-parse без fallback. Нет fence → обычный ответ; битый
   fence → видимая ошибка с причиной + ручная кнопка «повторить». Без
   авторетраев, regex-fallback не оставлять.
7. **Q3 (решено)**: S2+S3 одним релизом, без experiment-flag.
8. **Q5 (решено)**: битый verdict → сразу needsOperator, без авторетраев;
   ретрай — ручной кнопкой.
9. **Q6 (решено)**: кондуктор prompt-only («plan or answer only»); tool call
   кондуктора → видимый бейдж «исполняет сам». Harness-запрет — только при
   реальной протечке.
10. **Прозрачность — свойство любого чата**; авто-поведение (волны) — только у
    conductor-типа. Plain-чаты не меняют поведения.
11. Не удалять `roleCatalog.ts` (нужен валидации слоёв) и
    `subagentToolCalls.ts` (фундамент проекции 2b).
12. Отчёт наверх = **реальное user-сообщение** (envelope) через berdctl-seam
    (`session send`, `if_running=queue`) для родителя любого типа — вводится в
    3a; до 3a живёт синтетический `publishCompletedTurns`.

## Контракты Этапа 0 (обязательны для всех последующих пунктов)

1. `SessionNode.managedBy: "ui" | "wave" | "agent-cli"` — wave-машина управляет
   только `"wave"`; миграция localStorage: ноды без поля → `"ui"`. Для
   wave-детей дополнительно `waveId`, `stepIndex`.
2. `anchorMessageId` обязателен для wave-детей и равен `planMessageId`
   (сообщению кондуктора с fence). Это же поле — ключ per-message футера.
3. Навигация из чипа — intent `{openInTab | navigate | reveal}` в
   `ConductorTranscriptContext`, не прямой `onSelectSession`.
4. Один словарь `RunStatus`; эфемерные harness-субагенты мапятся из
   tool-статусов: pending/in_progress → running, completed → completed,
   failed → failed, stopped → cancelled; конец turn'а терминализирует висящие.
5. Один модуль валидации ролей/слоёв (появляется в 1b, используется движком,
   berdctl `--role` и валидатором few-shot примеров).

## Порядок работ

```text
Этап 0: контракты                                  ← до всего
Этап 1: 1a футер | 1b S1-библиотека | 1c reconcile | 1d индикатор   ← параллельно
Этап 2: 2a S2+S3 волны (после 0,1a,1b)  ∥  2b harness-проекция (после 0)
Этап 3: 3a digest/verdict + poke  →  3b вкладки дочерних чатов
Этап 4: 4a per-step model → 4b berdctl --parent/--role → 4c скиллы
Этап 5: 5a Agents-сайдбар | 5b hardening | 5c N1-research | 5d examples
Этап 6: re-baseline, .distill, полировка
```

Ветки: одна ветка на пункт от актуального main (`feat/stage0-contracts`,
`feat/t1-footer`, `feat/s1-wave-lib`, `feat/t6-reconcile`, `feat/n1-indicator`,
`feat/wave-engine`, `feat/harness-brigade`). 2a стартует только после мержа
0, 1a и 1b.

## Спецификации ближайших пунктов

### 0. Контракты [S]

- `types.ts`: `managedBy`, `waveId?`, `stepIndex?` в `SessionNode`.
- `conductorGraphStore.ts`: parse/persist новых полей; миграция default `"ui"`.
- Существующие точки регистрации (`registerConductorSession`,
  `spawnConductorChildSession`) ставят `managedBy:"ui"`.
- `ConductorTranscriptContext`: `onOpenChild(sessionId, intent?)`, дефолт
  `navigate` (поведение не меняется).

Готово когда: сборка зелёная, существующий conductor-флоу работает как раньше,
старый localStorage-граф читается.

### 1a. Футер бригады per-message, ниже строки действий [S]

- `MessageBubble.tsx`: футер рендерится **после/ниже** строки действий и
  времени (сейчас вставлен до absolute-блока actions и виден выше него).
- Привязка per-message: сообщение показывает детей с
  `anchorMessageId === message.id`; дети без anchor — фолбэк на текущий
  `latestConductorFooterHostId`. Футеры исторических сообщений постоянны.
- Компонент чипа выделить переиспользуемым (понадобится 2b и placeholder'ам 5b).

Готово когда: две волны в conductor-чате видны каждая под своим сообщением,
чипы ниже времени, живые статусы у активной.

### 1b. Протокольная библиотека S1 [M] (без прошивки в рантайм)

- `distillWave.ts`: tri-state парс (нет fence / валиден / невалиден с
  перечисленной причиной: JSON, >5 шагов, пустой subtask, access не
  `[]`/`"all"`, роль не worker-layer, model не строка).
- Парсер `distill-verdict` — токены вердикта фиксируются здесь один раз.
- `wavePrompts.ts`: протокольный промпт кондуктора + `buildWaveStepPrompt`
  (вставка отчётов при `"all"`).
- Модуль валидации ролей/слоёв поверх `roleCatalog`.
- Vitest на всё; в UI не подключать.

### 1c. Reconcile статусов при старте [S]

После гидрации сессий: orchestrator/worker-ноды со статусом
starting/running/waiting, чья сессия реально не исполняется (нет runtime state,
нет queued-отправки) → `stopped`. Закрывает «второй Atlas висит running
навсегда».

### 1d. Индикатор «ждёт внешнюю работу» [S]

Чат, у которого есть работающие graph-дети, а сам он idle — показывает
индикатор у композера («N исполнителей работают, итог придёт сообщением»).
**Кнопку-poke не делать**: до 2a сообщение в кондуктор перехватит авто-спавн и
наспавнит новую бригаду; poke появляется в 3a вместе с digest-машиной.

### 2a. S2+S3 — модельный кондуктор + движок волн, одним релизом [L]

S2:
- Сузить short-circuit в `sendCore.ts`: conductor-сессии диспатчатся в
  `acpSendMessage` с протокольным промптом из `wavePrompts.ts`; short-circuit
  остаётся только для legacy оркестраторных оболочек.
- **Удалить**: `planOrchestratorTasks.ts`(+тест), `useConductorAutoSpawn.ts`,
  `userMessagesNeedingOrchestrator.ts`(+тест),
  `wrapOrchestratorCoordinationPrompt` (в `orchestratorReport.ts`),
  `selectRoleForTask` (сам `roleCatalog` остаётся), мёртвые экспорты
  `spawnOrchestratorSession`, `emptyStructuredReport`; вызов авто-спавна из
  `ChatView.tsx`.

S3 (движок в глобальном sync, работает при закрытом чате):
- Детект `distill-wave` fence в assistant-сообщениях кондуктора; persisted
  `planMessageId`; повторный парс не зацикливается (tombstone).
- Валидный план → спавн воркеров напрямую под кондуктором:
  `spawnConductorChildSession` c `role:"worker"`, `managedBy:"wave"`, `waveId`,
  `stepIndex`, `anchorMessageId=planMessageId`; промпт шага —
  `buildWaveStepPrompt`.
- `access:[]` → спавн сразу, параллельно; `"all"` → ждать терминальности всех
  предыдущих шагов волны, отчёты вложить в промпт; упавший предыдущий не
  блокирует.
- Битый fence → видимая ошибка с причиной + tombstone + ручная кнопка
  «повторить» (Q2). Шаги с полем `model` → отклонять видимо до 4a (D5-щель).
- Персистентное состояние волны (расширение graph store или соседний ключ).
- Мост до 3a: `publishCompletedTurns` научить группе wave-воркеров по
  `anchorMessageId` (сейчас фильтрует только role=orchestrator — иначе итог
  волны не публикуется вовсе).
- Миграция: старые ноды (`managedBy:"ui"`) движок не трогает.

Готово когда: многочастный запрос кондуктору → модель отвечает планом → чипы
под план-сообщением (per 1a) → воркеры исполняются и завершаются → один
синтетический итог; битый fence показывает ошибку и ничего не спавнит;
рестарт посреди волны не дублирует спавн.

### 2b. Проекция harness-субагентов [M] (любой чат)

- Новый селектор/модуль (`features/chat/lib/harnessBrigade.ts`): из content
  turn'а собрать эфемерные записи по subagent tool calls
  (`getSubagentToolCallInfo`/уже проставленным `subagentAgentName` полям):
  имя, задача, статус по контракту №4; Goose `load(task_id)` обновляет запись
  своего delegate (связка `resolveDelegateContextForTask`).
- Рендер: тем же чип-компонентом (1a) под host-сообщением в **любом** чате +
  live-strip в зоне шагов, пока ответа нет.
- Клик по эфемерному чипу — раскрыть/подскроллить его tool-карточку (своего
  чата у in-harness агента нет — не имитировать).
- Ничего не пишет в граф, сессий не создаёт.

Готово когда: Ultracode/Task-воркфлоу в plain-чате виден живыми чипами во
время работы и остаётся под сообщением после.

### Этапы 3–6 — кратко (детальные спеки добавляются при re-baseline перед стартом этапа)

- **3a** digest/verdict: терминальный ребёнок (любой `managedBy`) → envelope
  реальным user-сообщением родителю (berdctl-seam, `if_running=queue`);
  wave-надстройка: persisted стейт-машина, verdict accept / одна ревизия /
  needsOperator, кап 2, битый verdict → needsOperator (Q5); ревизионная волна
  с `"all"` видит отчёты предыдущей волны корня; удалить
  `publishCompletedTurns`; кнопка-poke; digest-сообщения — компактной
  карточкой; бейдж «кондуктор исполняет сам» при tool call (Q6).
- **3b** вкладки дочерних чатов по образцу `ArtifactViewerPanel`; intent
  `openInTab`; back-banner остаётся.
- **4a** per-step model (`resolveWaveStepTarget`, ошибка до спавна, суффикс на
  чипе); **4b** `berdctl session create --parent --role --name --task` +
  `registerNode(managedBy:"agent-cli")`; **4c** скиллы
  orchestrate/dispatch/providers по расписанию handoff §6 Track B.
- **5a** Agents-секция сайдбара; **5b** hardening (degraded-report warning,
  wave-stop, placeholder-чипы, стоимость кондуктора); **5c** research wake для
  in-harness воркфлоу (адаптер / journal-watcher); **5d** orchestrate-examples
  (OOD, abdication, валидация по JSON и слою ролей).
- **6** `.distill`, группировка чипов по волнам, токены/стоимость на чип,
  финальный re-baseline.

## Что запрещено делать вместо пунктов плана

- превращать plain-чаты в conductor-режим;
- второй session manager (4b — только флаги к существующему `createSession`);
- fine-grained access-графы; MoA-агрегация; свой RL; репутационные приоры
  моделей; неограниченные ревизии;
- авторетраи парса/вердикта (Q2/Q5);
- `.distill`, SQL, relay/server-инфраструктура до этапа 6;
- удалять `roleCatalog.ts` или `subagentToolCalls.ts`;
- массовый rebrand;
- завершать задачу без работающего UI (кроме 0 и 1b).

## Быстрая проверка после каждого пункта

Запустить приложение и пройти «Готово когда» своего пункта руками; чинить
только сборку и ошибки этого сценария. Полное покрытие — после подтверждения
оператором.

## Ссылки

- `../combined_plan.md` — объединённый план с обоснованием и сверкой треков.
- `../conductor_handoff.md` — протокол волн, проверенные факты кода и статьи.
- `../launch_prompts.md` — готовые промпты для implementation-агентов.
