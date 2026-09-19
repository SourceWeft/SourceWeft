// Run with an authenticated local SW page, as with pc-context.acceptance.mjs.
// Does not send a message or register/connect a computer.
export default async (page) => {
  const base = new URL(page.url()).origin;
  for (const query of ["", "?computer=cloud"]) {
    await page.goto(`${base}/dashboard/chat${query}`);
    const editor = page
      .getByRole("textbox", {
        name: "Message your documents, links, or connected tools...",
      })
      .filter({ visible: true });
    await editor.waitFor();
    if (!(await editor.isEnabled()))
      throw new Error("Cloud editor is disabled");
    const selector = page.getByRole("button", {
      name: "Choose cloud or computer",
    });
    if (!(await selector.textContent()).includes("Cloud"))
      throw new Error("Web new chat did not default to Cloud");
    await selector.click();
    await page
      .getByRole("button", { name: "Connect a computer…", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Connect a computer",
      exact: true,
    });
    await dialog.waitFor();
    await page
      .getByText("Loading computers…", { exact: true })
      .waitFor({ state: "hidden" });
    if (await dialog.getByRole("alert").count())
      throw new Error("Computer discovery returned an error");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await editor.waitFor();
  }
};
