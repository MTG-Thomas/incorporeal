-- An approval names the action it authorises.
--
-- The first version of this schema approved a *task*: a human decided that
-- the task may act, and the model chose the command afterwards. That is a
-- broad licence - a human who approved "run the tests" had, in effect,
-- approved "let this agent run anything".
--
-- The action is stored on the approval, and an execution must match it.

ALTER TABLE approvals ADD COLUMN requested_action TEXT;
