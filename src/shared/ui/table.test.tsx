import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Table, TableBody, TableCell, TableRow } from "./table";

describe("TableRow", () => {
  it("marks a row whose subject is worked on or paused, and only those", () => {
    render(
      <Table>
        <TableBody>
          <TableRow activity="working">
            <TableCell>measured now</TableCell>
          </TableRow>
          <TableRow activity="paused">
            <TableCell>measurement paused</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>idle</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const [working, paused, idle] = screen.getAllByRole("row");
    expect(working).toHaveAttribute("data-activity", "working");
    expect(paused).toHaveAttribute("data-activity", "paused");
    expect(idle).not.toHaveAttribute("data-activity");
  });
});
