import { expect, it } from "vitest";
import { firstById } from "../lib/benchmarkLookup";

it("keeps first-match cost and task-number lookups and nullable fallbacks across a large run", () => {
  const rows = Array.from({ length: 5_000 }, (_, index) => ({
    id: `invented-${index}`,
    cost: index % 3 === 0 ? null : index % 3 === 1 ? 0 : index / 100,
    number: index + 41,
  }));
  rows.push({ id: rows[0].id, cost: 999, number: 999 });
  const indexed = firstById(rows);
  for (const id of [...rows.map((row) => row.id), "missing"]) {
    const before = rows.find((row) => row.id === id);
    const after = indexed.get(id);
    expect(after).toBe(before);
    expect(after?.cost ?? 0.125).toBe(before?.cost ?? 0.125);
    expect(after?.number).toBe(before?.number);
  }
});

it("indexes IDs once and performs repeated lookups without rescanning evidence", () => {
  let reads = 0;
  const rows = Array.from({ length: 5_000 }, (_, index) => ({
    get id() {
      reads += 1;
      return `invented-${index}`;
    },
    number: index,
  }));
  const indexed = firstById(rows);
  expect(reads).toBeLessThanOrEqual(rows.length * 2);
  const built = reads;
  for (let index = 0; index < rows.length; index += 1) {
    expect(indexed.get(`invented-${index}`)).toBe(rows[index]);
  }
  expect(reads).toBe(built);
});
