import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import type { AttentionCard } from "../src/card-model.ts";
import { SERVER_VERSION } from "../src/version.ts";
import { sizeWords } from "../src/move-to.ts";


const root = document.querySelector<HTMLElement>("#card")!;

// Every Zoom-derived string lands in textContent, never in markup.
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  for (const kid of kids) node.append(kid);
  return node;
};
const message = (text: string) => root.replaceChildren(el("p", { class: "error" }, text));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Renders the result as sent: order, levels, wording and next steps are the tool's. */
export const paint = (data: AttentionCard) => {
  const head = el(
    "header",
    { class: "head" },
    el("span", { class: "eyebrow" }, `Zoom Rooms · needs attention${data.source === "demo" ? " · demo data" : ""}`),
    el("p", { class: "headline" }, data.headline),
  );
  // Green only for a real all-clear. Nothing wrong but something unread is grey, never green.
  const pills: Node[] = [];
  if (data.counts.critical) pills.push(el("span", { class: "pill l-critical" }, `${data.counts.critical} critical`));
  if (data.counts.warning) pills.push(el("span", { class: "pill l-warning" }, `${data.counts.warning} warning`));
  if (data.allClear) pills.push(el("span", { class: "pill l-ok" }, "All clear"));
  else if (!data.needAttention) pills.push(el("span", { class: "pill l-unknown" }, "Not an all-clear"));
  if (data.couldNotCheck.length) pills.push(el("span", { class: "pill l-unknown" }, `${data.couldNotCheck.length} could not check`));
  pills.push(el("span", { class: "of" }, `${plural(data.total, "room")} in the account`));
  const parts: Node[] = [head, el("div", { class: "tally" }, ...pills)];

  if (data.rooms.length) {
    parts.push(
      el(
        "ol",
        { class: "rooms", "aria-label": "Rooms, worst first" },
        ...data.rooms.map((room) => {
          const offline = room.status.toLowerCase() === "offline";
          const badges = [el("span", { class: `badge${offline ? " l-critical" : ""}` }, room.status || "No status")];
          const free = (room as { moveTo?: { name: string }[] }).moveTo ?? [];
          const taken = (room as { moveToNote?: string | null }).moveToNote ?? null;
          if (room.inMeeting) badges.push(el("span", { class: "badge meeting", title: "A meeting is running in this room now" }, free.length ? `In a meeting: fix after it ends, or move it to ${free[0]!.name}${sizeWords(room)}` : taken ? `In a meeting: fix after it ends; ${taken}` : "In a meeting: fix after it ends"));
          const body: Node[] = [];
          if (room.issues.length)
            body.push(el("ul", { class: "issues" }, ...room.issues.map((i) => el("li", {}, i.issue, ...(i.since ? [el("span", { class: "since" }, ` since ${i.since}${i.age ? `, ${i.age} ago` : ""}`)] : [])))));
          if (room.devices.length) body.push(el("p", { class: "devices" }, el("b", {}, "Not online"), room.devices.join("; ")));
          body.push(el("p", { class: "next" }, el("b", {}, "Next"), room.next));
          return el(
            "li",
            { class: `room l-${room.level}` },
            el(
              "div",
              { class: "room-head" },
              el("span", { class: "lvl" }, room.level === "critical" ? "Critical" : "Warning"),
              el("span", { class: "name" }, room.name),
              ...(room.where ? [el("span", { class: "where" }, room.where)] : []),
            ),
            el("div", { class: "badges" }, ...badges),
            ...body,
          );
        }),
      ),
    );
  }
  if (data.notReadInDetail.length)
    parts.push(el("p", { class: "more" }, `${plural(data.notReadInDetail.length, "more problem room")} not read in detail: ${data.notReadInDetail.join(", ")}.`));
  if (data.couldNotCheck.length) parts.push(el("section", { class: "section" }, el("h3", {}, "Could not check"), el("ul", { class: "cnc" }, ...data.couldNotCheck.map((t) => el("li", {}, t)))));
  parts.push(el("footer", { class: "foot" }, el("span", {}, "Read-only"), el("span", {}, "Offline rooms first"), el("span", {}, "Unknown is never green")));
  root.replaceChildren(...parts);
};

const app = new App({ name: "Zoom Rooms attention card", version: SERVER_VERSION }, {}, { autoResize: true });
const applyHost = (context: ReturnType<App["getHostContext"]>) => {
  if (!context) return;
  if (context.theme) applyDocumentTheme(context.theme);
  const insets = context.safeAreaInsets;
  if (insets) document.documentElement.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
};
app.ontoolinput = () => message("Reading the rooms.");
app.ontoolresult = (result) => {
  const data = (result as { _meta?: { card?: AttentionCard } })._meta?.card;
  if (data?.kind === "attention") paint(data);
  else message(result.isError ? "This could not run. The reply above says why." : "Nothing to show.");
};
app.onhostcontextchanged = applyHost;
app
  .connect()
  .then(() => applyHost(app.getHostContext()))
  .catch(() => message("The card could not connect to the host."));
