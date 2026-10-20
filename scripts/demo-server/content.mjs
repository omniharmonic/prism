// The reviewer demo server's sample workspace. FICTIONAL ONLY: every name, project and number
// here is made up (most are the ones the browser fixtures use — apps/web/e2e-fixtures/databases.tsx,
// apps/server/test/fixtures/e2e-server.ts). Nothing here may name a real person, the owner, a real
// server or a real address; `apps/server/test/demo-server.test.ts` checks it against the
// public-snapshot personal-data patterns.
//
// Every note carries SAMPLE_TAG so a person can find all of it; the reset script removes every
// note in the demo vault anyway (the reviewer may create untagged pages).

export const SAMPLE_TAG = "demo-sample";
const at = "2026-10-01";

const RICH =
  "<h2>Purpose</h2>" +
  "<p>A single, evolving place for <strong>notes</strong>, <em>tasks</em> and <u>sources</u> — shared with the people you choose.</p>" +
  '<p>Read the <a href="https://example.com/guide">guide</a> and <mark data-color="#fef08a" style="background-color: #fef08a; color: inherit">highlight</mark> what matters.</p>' +
  "<h2>How we work</h2>" +
  "<ul><li><p>Write things down where everyone can find them</p></li><li><p>Keep tasks small and visible</p></li><li><p>Review changes before they land</p></li></ul>" +
  '<ul data-type="taskList">' +
  '<li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Set up the workspace</p></div></li>' +
  '<li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>Invite the team</p></div></li>' +
  "</ul>" +
  "<blockquote><p>Good tools disappear; the work stays.</p></blockquote>" +
  "<pre><code>prism status   # is the server healthy?</code></pre>";

const task = (title, meta, body) => ({
  path: `Projects/Launch plan/${title}`,
  content: `<p>${body}</p>`,
  tags: ["task", SAMPLE_TAG],
  metadata: { title, ...meta },
});

/** The sample notes, in creation order (parents before children). */
export function sampleNotes() {
  return [
    {
      path: "Welcome",
      tags: [SAMPLE_TAG],
      metadata: { title: "Welcome to the Prism demo", icon: "👋" },
      content:
        "<p>This is a demo workspace with made-up content. Everything here can be changed — it is reset regularly.</p>" +
        "<h2>Things to try</h2>" +
        "<ul>" +
        "<li><p>Open <strong>A living workspace</strong> and edit it; changes save as you type.</p></li>" +
        "<li><p>Select text and add a <strong>comment</strong>.</p></li>" +
        "<li><p>Open the <strong>Launch plan</strong> database: switch between table and board, change a status.</p></li>" +
        "<li><p>Create a new page with <strong>New page</strong>, and find it again with search.</p></li>" +
        "<li><p>Look at a page's <strong>history</strong> in the page menu.</p></li>" +
        "<li><p>Settings → Account → <strong>Delete account</strong> deletes this demo account (the demo is reset afterwards).</p></li>" +
        "</ul>",
    },
    {
      path: "Projects/A living workspace",
      tags: ["research", SAMPLE_TAG],
      metadata: { title: "A living workspace", status: "in-progress", priority: "medium" },
      content: RICH,
    },
    {
      path: "Projects/Launch plan",
      tags: [SAMPLE_TAG],
      content: "<p>Plan and ship the next release. Keep tasks focused, visible and moving.</p>",
      metadata: {
        prism_type: "database",
        title: "Launch plan",
        prism_database: {
          version: 1,
          source: { tags: ["task", SAMPLE_TAG] },
          views: [
            { id: "table", name: "All tasks", type: "table", visible: ["status", "priority", "due"] },
            { id: "board", name: "By status", type: "board", groupBy: "status", visible: ["priority", "due"] },
          ],
        },
      },
    },
    task("Draft the announcement", { status: "in-progress", priority: "high", due: "2026-11-03" }, "A short post: what is new, who it is for, how to try it."),
    task("Review onboarding copy", { status: "todo", priority: "medium", due: "2026-11-05" }, "Read the first-run screens aloud; cut every sentence that is not needed."),
    task("Prepare release notes", { status: "todo", priority: "low", due: "2026-11-10" }, "Collect the merged changes and group them by what people will notice."),
    task("Fix sign-in screen spacing", { status: "done", priority: "medium", due: "2026-10-20" }, "The button sat too close to the field on small phones."),
    { path: "People/Mira Chen", tags: ["person", SAMPLE_TAG], metadata: { title: "Mira Chen", role: "Design" }, content: "<p>Fictional teammate. Leads design for the launch.</p>" },
    { path: "People/Sam Rivera", tags: ["person", SAMPLE_TAG], metadata: { title: "Sam Rivera", role: "Engineering" }, content: "<p>Fictional teammate. Looks after the server and the apps.</p>" },
    { path: "Projects/Atlas", tags: ["initiative", SAMPLE_TAG], metadata: { title: "Atlas", stage: "active", budget: 12500 }, content: "<p>Atlas: a fictional initiative to map how a small team shares its notes.</p>" },
    { path: "Projects/Beacon", tags: ["initiative", SAMPLE_TAG], metadata: { title: "Beacon", stage: "planning", budget: 800.5 }, content: "<p>Beacon: a fictional initiative about weekly updates.</p>" },
    {
      path: "Projects/Initiatives",
      tags: [SAMPLE_TAG],
      content: "",
      metadata: {
        prism_type: "database",
        title: "Initiatives",
        prism_database: { version: 1, source: { tags: ["initiative", SAMPLE_TAG] }, views: [{ id: "table", name: "All initiatives", type: "table", visible: ["stage", "budget"] }] },
      },
    },
    {
      path: "Notes/Weekly sync",
      tags: [SAMPLE_TAG],
      metadata: { title: "Weekly sync", date: at },
      content:
        "<h2>Agenda</h2><ol><li><p>Launch plan status</p></li><li><p>Open questions</p></li></ol>" +
        "<h2>Decisions</h2><p>Ship the announcement draft for review by Friday.</p>" +
        "<h2>Follow-ups</h2><p>Mira: final screenshots. Sam: release checklist.</p>",
    },
  ];
}
