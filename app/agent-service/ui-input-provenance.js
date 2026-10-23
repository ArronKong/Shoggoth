"use strict";
// These labels are assigned by the trusted Coordinator, never by HTML. UI
// declarations/defaults plus selected values are conversation input, but not
// the user's independently stated durable facts.
function isUiActionSubmission(event) {
  return event?.kind === "user" && (event.content?.origin === "ui_action_submission"
    || event.origin === "ui_action_submission");
}
module.exports = { isUiActionSubmission };
