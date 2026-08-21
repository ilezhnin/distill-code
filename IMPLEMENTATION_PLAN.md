# Distill Code — production-first implementation plan

Status: active

Updated: 2026-08-20

## Рабочий принцип

Сначала появляется работающий продукт, который оператор может открыть и
попробовать. Тесты, доказательные спайки, отчёты о спайках и подробная
документация не являются входным условием разработки.

Первый агент должен сразу менять продукт и закончить работу видимым сквозным
сценарием. Нельзя завершать задачу исследованием, планом, набором типов,
макетом, тестами без интерфейса или документом о том, что когда-нибудь нужно
реализовать.

После появления работающего UI допускается минимальная проверка запуска и
сборки. Полное тестовое покрытие и формализация выполняются позже, когда
оператор увидит продукт и подтвердит направление.

## Что строим

```text
Project
└─ Conductor chat — единственный основной разговор с оператором
   ├─ Orchestrator session A — одна ограниченная задача или этап
   │  ├─ Worker A1
   │  └─ Worker A2
   └─ Orchestrator session B
      └─ Worker B1
```

Кондуктор:

- принимает запрос оператора;
- выбирает исполнителя, модель, reasoning effort и лимиты;
- создаёт, останавливает и перезапускает оркестраторов;
- получает от них результат;
- не копирует в основной чат сырые логи и повторы;
- показывает наверх итог, решения, риски, артефакты и блокеры;
- позволяет оператору открыть любого исполнителя и вмешаться напрямую.

Worktree, terminal и checkout являются ресурсами конкретного запуска, а не
главными сущностями интерфейса.

## Зафиксированные архитектурные решения

1. Этот репозиторий — единственный продуктовый репозиторий.
2. Berd остаётся основой desktop-приложения: Tauri 2, React 19, проекты, чаты,
   навигация, ACP, providers, personas, фоновые сессии и `berdctl` переиспользуются.
3. Upstream Goose пока остаётся встроенным невидимым `goose serve` sidecar.
   Пользователь не устанавливает и не открывает отдельное приложение Goose.
4. Не изменять `goose-backend.lock.json` и sibling `distill-goose`, пока
   конкретная продуктовая функция действительно не упрётся в backend.
5. Buzz не является runtime-зависимостью. `../distill-buzz` — донор решений для
   статусов, activity feed, agent identity, raw/polished view и liveness.
6. Не переносить из Buzz Nostr, Postgres, Redis, S3, communities, membership и
   Git collaboration stack.
7. `.distill` станет переносимым источником истины проекта. SQL не нужен в
   основном контуре.
8. Credentials, токены и provider secrets никогда не пишутся в `.distill`.
9. Не начинать с массового ребрендинга Berd. Сначала рабочая иерархия сессий.
10. Обычный чат остаётся обычным чатом. Conductor — явный тип чата, а не режим,
    который незаметно меняет все существующие разговоры.

## Что уже есть и должно переиспользоваться

Перед изменением кода быстро прочитать, но не превращать чтение в отдельный
этап работы:

- `AGENTS.md`
- `LAWS/README.md`, `LAWS/AGENTS.md`, `LAWS/CHAT.md`
- `docs/berdctl-architecture.md`
- `src/features/berdctl/commands/impl/createSession.ts`
- `src/features/berdctl/commands/impl/sendSession.ts`
- `src/features/berdctl/commands/runtime/sessions.ts`
- `src/features/chat/stores/chatSessionStore.ts`
- `src/features/chat/stores/chatSessionOperations.ts`
- `src/features/chat/lib/sessionExecutionTarget.ts`
- `src/features/chat/lib/sessionActivity.ts`
- `src/features/chat/lib/queuedSessionSend.ts`
- `src/features/chat/acp/acpNotificationHandler.ts`
- `src/features/projects/stores/projectStore.ts`
- `src/features/projects/lib/projectChatWorkspaces.ts`

Первый кандидат для создания оркестратора — существующий путь, который
использует `berdctl session create`. Нельзя строить второй независимый session
manager, если существующий store/API можно вызвать напрямую.

Полезные Buzz-референсы, которые можно адаптировать после появления нашего
domain model:

- `../distill-buzz/VISION_ACTIVITY.md`
- `../distill-buzz/desktop/src/features/agents/activeAgentTurnsStore.ts`
- `../distill-buzz/desktop/src/features/agents/agentWorkingSignal.ts`
- `../distill-buzz/desktop/src/features/agents/ui/ManagedAgentSessionPanel.tsx`

Не копировать Buzz-типы `channel`, `pubkey`, relay events и Nostr identity в
ядро Distill Code.

## Минимальный domain model

Ядро должно быть harness-neutral:

```ts
type SessionRole = "conductor" | "orchestrator" | "worker" | "plain-chat";

type RunStatus =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "stopped";

interface SessionNode {
  sessionId: string;
  projectId: string;
  role: SessionRole;
  parentSessionId: string | null;
  rootConductorId: string | null;
  runId: string | null;
  harnessId: string;
  modelProviderId?: string;
  modelId?: string;
  displayName: string;
  icon?: string;
  status: RunStatus;
}

interface StructuredReport {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  decisions: string[];
  artifacts: Array<{ label: string; path?: string; url?: string }>;
  risks: string[];
  needsOperator: boolean;
  nextSuggestedTask: string | null;
}
```

Не нужно сначала строить идеальный event-sourcing framework. Добавлять только
поля, необходимые работающему экрану и восстановлению текущего дерева.

## Первый production slice — делать немедленно

Результатом первой задачи должен стать UI, который оператор может запустить и
пощупать.

### 1. Conductor как реальный тип чата

- Добавить создание conductor-чата внутри проекта.
- В навигации conductor должен отличаться от обычного чата именем/иконкой.
- Не менять поведение существующих plain chats.

### 2. Создание одного настоящего оркестратора

- В conductor-чате добавить работающий action создания дочерней сессии.
- Использовать существующий session creation path.
- Передавать выбранные harness, model/provider и рабочую папку.
- Сохранить `parentSessionId`, `rootConductorId`, роль, имя и run id.
- На первом срезе допустим ручной выбор задачи/исполнителя в UI. Автоматический
  выбор кондуктором добавляется следующим этапом.

### 3. Живой статус под ответом/задачей кондуктора

Показывать компактную строку:

```text
● Atlas — анализ архитектуры      running
```

Состояния:

```text
blue / visible label       starting
animated / visible label   running
amber / visible label      waiting
red / visible label        failed
green / visible label      completed
gray / visible label       stopped or cancelled
```

Цвет не должен быть единственным носителем смысла.

### 4. Переход в дочерний чат

- Клик по строке/кружку открывает настоящий transcript оркестратора.
- Оператор может отправить ему уточнение обычным composer.
- Можно вернуться к conductor, не потеряв состояние дочерней сессии.

### 5. Возврат результата наверх

- При завершении дочерней сессии её итог появляется у conductor как одна
  очищенная карточка, а не копия полного transcript.
- Для первой рабочей версии допустимо использовать последнее завершённое
  assistant-сообщение как `summary`, оставив остальные поля отчёта пустыми.
- Raw transcript остаётся доступен по клику на дочернюю сессию.

### 6. Минимальное восстановление

- После перезапуска приложения conductor должен по-прежнему знать своего
  оркестратора и его последний статус/результат.
- Использовать существующее persistent session state как самый быстрый путь.
- Если для связи parent/child нужен отдельный небольшой store, сделать его
  сейчас. Полный перенос в `.distill` выполняется следующим этапом.

## Что запрещено делать вместо первого среза

Нельзя тратить первую задачу на:

- написание тестов до появления работающего UI;
- тестовую документацию;
- отдельный отчёт о baseline/spike;
- доказательство, что архитектура когда-нибудь заработает;
- макеты без реальной ACP-сессии;
- только типы и reducer без интерфейса;
- полный event-sourcing framework;
- SQL, relay или server infrastructure;
- импорт больших экранов Buzz;
- форк Goose без реального блокера;
- массовый rename/rebrand;
- автоматическое планирование нескольких команд;
- идеальную схему памяти и backup до первого запускаемого продукта.

Если встречается неопределённость, выбрать самый простой обратимый вариант,
который даёт рабочий экран, и продолжать.

## Быстрая проверка после появления продукта

Только после того, как сквозной сценарий реализован:

1. Запустить приложение.
2. Создать conductor.
3. Создать через него одного оркестратора.
4. Увидеть смену статуса.
5. Открыть дочерний чат и отправить сообщение.
6. Увидеть один итог у conductor.
7. Перезапустить приложение и проверить восстановление.

Не писать отдельные тесты и тестовые отчёты в первой задаче. Исправлять только
ошибки, которые мешают сборке или этому ручному сценарию.

## Следующий production slice

После подтверждения первого экрана оператором:

- автоматическое создание оркестратора самим conductor;
- два параллельных оркестратора;
- structured report со всеми полями;
- `operator.intervention` и уведомление родителя;
- orchestrator/agent sidebar;
- worker-проекция harness-native субагентов;
- stop/restart/replace;
- токены, стоимость, wall-time и context limits;
- перенос graph/events/reports в проектный `.distill`;
- память с ограничением прав записи;
- backup/import/export;
- Grok ACP preset;
- rebranding Distill Code.

## Готовый prompt для implementation agent

```text
Work immediately in E:\Unity\distill_code\distill-code on the existing
feat/conductor-vertical-slice branch.

Read AGENTS.md, the relevant LAWS files, and IMPLEMENTATION_PLAN.md, then start
changing the product immediately. Do not stop after research, planning, a
baseline report, domain types, tests, or documentation.

Implement the complete “Первый production slice — делать немедленно” from
IMPLEMENTATION_PLAN.md. The deliverable is a visible runnable product flow:

1. Create a conductor chat in a project.
2. From that conductor UI, create one real child orchestrator session through
   Berd's existing ACP/session creation path with a selected harness/model.
3. Show the child's live named status under the conductor task/response.
4. Clicking it opens the real child transcript, where the operator can send a
   direct message and return.
5. On completion, show one distilled result card in the conductor instead of
   copying raw chatter.
6. Preserve the parent/child link and last result across app restart using the
   fastest existing persistence seam.

Reuse createSession/sendSession/chatSessionStore and current navigation. Keep
plain chats unchanged. Do not add an experiment flag, tests, test docs, a spike
report, SQL, Nostr/relay infrastructure, broad Buzz UI copies, Goose changes,
or mass rebranding. Do not spend the task proving architecture before producing
UI.

Once the visible flow exists, launch it and fix only build/runtime blockers and
errors in that manual scenario. Finish by telling the operator exactly how to
open and try the new conductor flow, what is working, and what the next visible
slice should add.
```
