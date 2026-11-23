# Goals and loops

Use these commands at the start of a message in any Flock chat that accepts independent work. Type `/` in the composer to see the commands. Keep Flock running for automatic turns. You can switch to another chat or view while it works. The session list marks active goals and loops next to the chat title. When an automatic turn starts a new chat, its objective or loop prompt supplies the title. History previews and search snippets show the task and reply without the state instructions or state block.

## Work toward an objective

`/goal Review the draft and fix broken links --max-turns 8 --budget 40000` sets the objective and replaces any previous goal. Both options are optional. The turn allowance defaults to 30 and accepts 1 through 200. The token budget is a positive whole number and uses the usage reported by the provider.

Flock sends the objective when the chat is ready. After a reply, Flock checks whether the chat reports completion or needs help. If work remains and the allowance permits it, Flock queues another turn. Your queued messages go first. Reaching the allowance or encountering a provider failure pauses the goal. Stopping an automatic turn pauses its goal. This applies to Stop in the composer, brigade, and child panel, to `flockctl session stop`, and when the budget guard stops a session. A pre-turn rate limit waits for the provider.

Use `/goal` or `/goal status` to inspect progress. The indicator above the composer shows progress and the reason for a pause. Use its controls or send `/goal pause`, `/goal resume`, or `/goal clear`. Resume renews the turn and token allowances. Total recorded tokens and active elapsed time carry over. Each command adds one confirmation to the chat. Automatic changes, such as a goal reaching its allowance or a loop expiring, also appear once.

## Repeat a task

| Command | Result |
| --- | --- |
| `/loop 5m Check the build` | Runs once when the chat is ready, then every five minutes. |
| `/loop Check the build every 2 hours` | Uses the same fixed schedule with the interval at the end. |
| `/loop Check the build` | Lets the chat choose the next delay after each run. |
| `/loop` or `/loop list` | Shows loop numbers, next runs and expiry. |
| `/loop pause 2` or `/loop resume 2` | Controls loop 2. Omit the number to apply to every loop in this chat. |
| `/loop stop 2` or `/loop stop all` | Ends the named loop or every loop in this chat. |

Use `s`, `m`, `h`, or `d` for seconds, minutes, hours, or days. The minimum interval is one minute. A self-paced loop can request one minute to 24 hours and defaults to ten minutes. After each reply Flock checks for completion, then schedules the next run if needed. Three consecutive failures pause the loop. The same Stop controls pause only the loop whose turn is running. A stopped turn does not count toward the failure limit.

A chat can have five loops, including paused ones. Each expires seven days after creation. If the chat is busy or Flock is closed, missed intervals coalesce into one run when the chat becomes ready, provided the loop is still active and unexpired. A fixed loop keeps its original cadence. A due loop runs before the next automatic goal turn.

## Conductors and wave workers

A conductor waits during a live wave or a hold. A hold on the root conductor also withholds automatic turns in its child chats. An active roadmap prevents starting a goal and defers an existing goal. Wave workers follow their assigned steps and refuse both commands. An independent child chat reports a pause or ending to its parent. Archiving or deleting a chat removes its goals and loops.
