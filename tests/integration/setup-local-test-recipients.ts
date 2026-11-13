import { afterAll, beforeAll } from "vitest";
import { setFactsCliRegistration, setLocalTestRecipients } from "../support/local-test-recipients";

// DEV-263g: every integration file approves fictional shops / example.com addresses, so the database owner's local
// switch of the test-recipient guard is on for each file (the guard's own test switches it off and back). After each
// file both local switches go back to their default (off): the test-recipient switch, and the facts CLI registration
// switch (PR #269 M2) that tests turn on when they register facts through the CLI path.
beforeAll(async () => {
  await setLocalTestRecipients(true);
});
afterAll(async () => {
  await setFactsCliRegistration(false);
  await setLocalTestRecipients(false);
});
