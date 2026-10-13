import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp, screen, within } from "./render";

const bundleUrl = "/artifact/?run=golden-1&path=.vtc%2Fevidence%2FT-1%2Fbundle.json";

describe("Evidence bundle view (REQ → test → result matrix)", () => {
  it("renders a task bundle as facts plus the traceability matrix, raw JSON on demand", async () => {
    const user = userEvent.setup();
    renderApp(bundleUrl);
    expect(await screen.findByRole("heading", { name: "Task T-1 evidence" })).toBeInTheDocument();
    expect(screen.getByText("1/4")).toBeInTheDocument();
    expect(screen.getByText("$1.20")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: /Traceability/ });
    const rows = within(table).getAllByRole("row");
    // header + REQ-1 (1 test) + REQ-1.AC-1 (2 tests)
    expect(rows).toHaveLength(4);
    expect(within(table).getByRole("rowheader", { name: /REQ-1\.AC-1/ })).toHaveAttribute(
      "rowspan",
      "2",
    );
    const hidden = within(table).getByText("acceptance [REQ-1.AC-1] hash survives restart");
    const hiddenRow = hidden.closest("tr");
    if (hiddenRow === null) throw new Error("row");
    expect(within(hiddenRow).getByText("Pass")).toBeInTheDocument();
    expect(within(hiddenRow).getByText("hidden")).toBeInTheDocument();
    expect(within(hiddenRow).getByText("spec and observed")).toBeInTheDocument();
    expect(screen.getByText(/2 of 2 requirements covered/)).toBeInTheDocument();
    // Phones get the same matrix as one block per requirement.
    const phone = screen.getByRole("list", { name: "Requirements" });
    expect(within(phone).getAllByText(/covered/)).toHaveLength(2);
    expect(within(phone).getByText("hidden")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /junit\.xml/ })).toHaveAttribute(
      "href",
      "/artifact/?run=golden-1&path=.vtc%2Fevidence%2FT-1%2Fround-1%2Fjunit.xml",
    );
    const verdicts = screen.getByRole("list", { name: "Verdicts" });
    expect(within(verdicts).getByText(/spec_verifier/)).toHaveTextContent(
      "spec_verifier · REQ-1.AC-1: pass",
    );
    const raw = screen.getByText("Raw JSON");
    expect(screen.getByTestId("artifact-text")).not.toBeVisible();
    await user.click(raw);
    expect(screen.getByTestId("artifact-text")).toBeVisible();
  });

  it("renders a traceability report on its own", async () => {
    renderApp("/artifact/?run=golden-1&path=.vtc%2Fevidence%2FT-1%2Ftraceability.json");
    const table = await screen.findByRole("table", { name: /Traceability/ });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(screen.getByText(/No gaps/)).toBeInTheDocument();
  });

  it("keeps other artifacts as plain text", async () => {
    renderApp("/artifact/?run=golden-1&path=.vtc%2Fspec%2Fspec.md");
    expect(await screen.findByTestId("artifact-text")).toHaveTextContent("# Password reset");
    expect(screen.queryByRole("table")).toBeNull();
  });
});
