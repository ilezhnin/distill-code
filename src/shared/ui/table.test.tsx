import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Table, TableBody, TableCell, TableRow } from "./table";

describe("TableRow", () => {
  it("marks a row whose subject is being worked on, and only that one", () => {
    render(
      <Table>
        <TableBody>
          <TableRow working>
            <TableCell>measured now</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>idle</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const [working, idle] = screen.getAllByRole("row");
    expect(working).toHaveAttribute("data-working", "true");
    expect(idle).not.toHaveAttribute("data-working");
  });
});
