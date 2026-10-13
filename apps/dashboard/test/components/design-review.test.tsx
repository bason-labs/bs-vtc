import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { readFixture } from "../fixtures";
import { renderApp, screen, within } from "./render";

const PROTO = "http://127.0.0.1:4311/";

const withPrototype = () => ({
  "/api/health": () =>
    Response.json({
      ...(readFixture("health") as object),
      mode: "live",
      prototype_url: PROTO,
    }),
});

const saved = () => ({
  "/api/design/reviews": () =>
    Response.json({ ok: true, path: ".vtc/design/reviews/reset-request.jsonl" }),
});

const frame = (): Promise<HTMLIFrameElement> =>
  screen.findByTitle<HTMLIFrameElement>(/Prototype: reset-request/);

describe("Design review (spec §17)", () => {
  it("embeds the prototype origin only in a sandbox=allow-scripts iframe", async () => {
    renderApp("/design/?run=golden-1", withPrototype());
    const iframe = await frame();
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("src")).toBe(`${PROTO}reset/?state=empty&theme=light`);
    expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(iframe).toHaveAttribute("width", "1440");
    expect(screen.getByText(/Approval still happens in the Lead chat/)).toBeInTheDocument();
  });

  it("switches screen, state, viewport and theme, keeping them in the address", async () => {
    const user = userEvent.setup();
    renderApp("/design/?run=golden-1", withPrototype());
    await frame();
    await user.click(screen.getByRole("radio", { name: "error" }));
    expect((await frame()).getAttribute("src")).toBe(`${PROTO}reset/?state=error&theme=light`);
    await user.click(screen.getByRole("radio", { name: /Phone/ }));
    expect(await frame()).toHaveAttribute("width", "390");
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect((await frame()).getAttribute("src")).toBe(`${PROTO}reset/?state=error&theme=dark`);
    expect(window.location.search).toBe(
      "?run=golden-1&screen=reset-request&state=error&viewport=390&theme=dark",
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Screen" }), "reset-confirm");
    const confirm = await screen.findByTitle<HTMLIFrameElement>(/Prototype: reset-confirm/);
    expect(confirm.getAttribute("src")).toBe(`${PROTO}reset/confirm/?state=form&theme=dark`);
    expect(screen.getByText("Covers REQ-2, REQ-2.AC-1")).toBeInTheDocument();
  });

  it("lists the screen's comments and pins the ones made on this view", async () => {
    renderApp("/design/?run=golden-1", withPrototype());
    await frame();
    const list = await screen.findByRole("list", { name: "Comments on reset-request" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(/The heading competes/);
    expect(items[0]).toHaveTextContent("empty · 1440 px · light");
    expect(items[0]).toHaveTextContent("Ba");
    expect(items[1]).toHaveTextContent("error · 390 px · dark");
    const pins = screen.getByTestId("pins");
    expect(within(pins).getAllByTestId(/^pin-/)).toHaveLength(1);
    expect(within(pins).getByTestId("pin-1")).toHaveStyle({ left: "50%", top: "30%" });
  });

  it("pins a comment by clicking the frame and saves it through POST /api/design/reviews", async () => {
    const user = userEvent.setup();
    const app = renderApp("/design/?run=golden-1&viewport=390&theme=dark", {
      ...withPrototype(),
      ...saved(),
    });
    await frame();
    const add = screen.getByRole("button", { name: "Add comment" });
    await user.click(add);
    expect(add).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: /Place the pin here/ }));
    const form = screen.getByRole("form", { name: "New comment" });
    expect(within(form).getByRole("spinbutton", { name: /Across/ })).toHaveValue(50);
    await user.clear(within(form).getByRole("spinbutton", { name: /Down/ }));
    await user.type(within(form).getByRole("spinbutton", { name: /Down/ }), "12.5");
    await user.type(within(form).getByRole("textbox", { name: "Comment" }), "Button too small");
    await user.click(within(form).getByRole("button", { name: "Save pin" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Saved to .vtc/design/reviews/reset-request.jsonl",
    );
    const post = app.requests.find((r) => r.method === "POST");
    expect(JSON.parse(post?.body ?? "")).toEqual({
      screen: "reset-request",
      state: "empty",
      viewport: 390,
      theme: "dark",
      x_pct: 50,
      y_pct: 12.5,
      comment: "Button too small",
    });
    const list = screen.getByRole("list", { name: "Comments on reset-request" });
    expect(within(list).getByText("Button too small")).toBeInTheDocument();
    expect(within(screen.getByTestId("pins")).getAllByTestId(/^pin-/)).toHaveLength(1);
    expect(screen.queryByRole("form", { name: "New comment" })).toBeNull();
  });

  it("keeps the draft and shows the engine's refusal", async () => {
    const user = userEvent.setup();
    renderApp("/design/?run=golden-1", {
      ...withPrototype(),
      "/api/design/reviews": () =>
        Response.json(
          { error: { code: "bad_request", message: "screen not found" } },
          { status: 400 },
        ),
    });
    await frame();
    await user.click(screen.getByRole("button", { name: "Add comment" }));
    await user.click(screen.getByRole("button", { name: /Place the pin here/ }));
    const form = screen.getByRole("form", { name: "New comment" });
    await user.click(within(form).getByRole("button", { name: "Save pin" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Write a comment first.");
    await user.type(within(form).getByRole("textbox", { name: "Comment" }), "Hi");
    await user.click(within(form).getByRole("button", { name: "Save pin" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("screen not found");
    expect(within(form).getByRole("textbox", { name: "Comment" })).toHaveValue("Hi");
  });

  it("explains a missing prototype but still lists the comments", async () => {
    renderApp("/design/?run=golden-1");
    expect(await screen.findByText("No prototype is being served")).toBeInTheDocument();
    expect(screen.queryByTitle(/Prototype:/)).toBeNull();
    expect(
      await screen.findByRole("list", { name: "Comments on reset-request" }),
    ).toBeInTheDocument();
  });

  it("explains a missing screens.yaml", async () => {
    renderApp("/design/?run=golden-1", {
      ...withPrototype(),
      "/api/runs/golden-1/artifacts": () =>
        Response.json({ error: { code: "not_found", message: "no such file" } }, { status: 404 }),
    });
    expect(await screen.findByText("No screens to review yet")).toBeInTheDocument();
  });

  it("is reachable from the run navigation", async () => {
    renderApp("/escalations/?run=golden-1");
    const nav = await screen.findByRole("navigation", { name: "Run golden-1" });
    expect(within(nav).getByRole("link", { name: "Design" })).toHaveAttribute(
      "href",
      "/design/?run=golden-1",
    );
  });
});
