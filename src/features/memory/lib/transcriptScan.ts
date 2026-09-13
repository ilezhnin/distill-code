/**
 * The cheap halves of a transcript scan.
 *
 * Three drains — memory writes, memory recall, planner tasks — re-read the
 * tail of every cached transcript whenever the chat store changes, which
 * while a reply streams is once per token. Each message they look at used to
 * cost a linear search through up to two thousand tombstone ids and a join
 * of its text parts before the one test that rejects nearly every message:
 * does it mention the fence tag at all. These are the two operations made
 * cheap enough to run first.
 */

import { isTextContent, type Message } from "@/shared/types/messages";

/**
 * True when any text part of the message contains `needle`.
 *
 * The same answer `getTextContent(message).includes(needle)` gives for a
 * needle with no newline in it — the parts are joined with one — without
 * building the joined string for every message that does not mention it.
 */
export function messageMentions(message: Message, needle: string): boolean {
  for (const part of message.content) {
    if (isTextContent(part) && part.text.includes(needle)) return true;
  }
  return false;
}

const idSets = new WeakMap<readonly string[], ReadonlySet<string>>();

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * A list of ids as a set, built once per list.
 *
 * The stores keep their tombstones as arrays because that is what they
 * persist, and replace the array on every commit. Keyed by the array itself,
 * the set is built the first time a list is asked about and shared by every
 * later question about the same list — which is every message of every
 * scan until the next commit.
 *
 * A list that is not there at all answers "nothing" rather than throwing: the
 * caller is a store field, and a store can be stood in for — a test double, a
 * state shape from an older build — and the honest answer for a record that
 * does not exist is that it holds no ids. The alternative was the memory ACL
 * throwing inside the prompt composer, which costs the send.
 */
export function messageIdSet(
  ids: readonly string[] | null | undefined,
): ReadonlySet<string> {
  if (!ids) return NO_IDS;
  let set = idSets.get(ids);
  if (!set) {
    set = new Set(ids);
    idSets.set(ids, set);
  }
  return set;
}
