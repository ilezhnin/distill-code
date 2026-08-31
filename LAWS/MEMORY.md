# Memory: the operator's record

A memory is one short statement the operator keeps across sessions — a
standing fact, a decision, a preference — that the app writes into every later
prompt on their behalf. Agents keep and retire memories through a fenced block
tagged `distill-memory`, and ask for the ones a prompt did not carry through
one tagged `distill-recall`. It is written here, and not only in the prompts
that teach those blocks, because the store, the panel the operator edits and
the skills shipped to agents all have to agree on what may be kept, who may
keep it, and what may never be thrown away.

## Sovereignty

- The operator MUST be able to read, edit and delete every stored memory from
  within the app.
- The app MUST NOT delete a memory except on an explicit operator action.
- A memory displaced by a capacity bound MUST be archived, not deleted.
- Wherever a memory is shown, the app MUST show whether the operator or an
  agent wrote it.

## Writing

- An agent MUST NOT keep or retire a memory except through the
  `distill-memory` protocol.
- A memory request MUST be honoured only from a session whose layer is
  permitted to write to memory.
- A session that is not permitted to write to memory MUST NOT be taught the
  writing protocol.
- A wave-spawned executor MUST NOT receive the operator's memories or the
  protocols that reach them.
- A statement that carries a secret MUST NOT be stored.
- The app MUST NOT store an edited version of a statement it refused.

## Reading back

- A session that receives the operator's memories MUST be able to ask for
  stored memories that its prompt did not carry.
- An answer to such a request MUST mark an archived memory as archived.
- A memory scoped to one project MUST NOT reach a session working in another
  project. Reaching across projects is the operator's search, not the agent's.

## Project knowledge

- A project's knowledge wiki MUST live inside that project's own folder.
- A project's knowledge wiki MUST be readable without the application running.
- A wiki page MUST be written only by the operator or from the conductor's
  loop; an executor's findings reach the wiki through its report.
