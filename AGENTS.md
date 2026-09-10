# WebMCP Bridge agent instructions

These instructions apply to ChatGPT and other coding executors working through DevSpace.

## Git authorization

Git read and write operations are supported. When the user explicitly asks to commit and push:

1. inspect the final diff and run `npm run check` before committing;
2. stage only the files that belong to the requested change; never use `git add -A` as a shortcut;
3. create or use a branch named `chatgpt/<short-task-name>`;
4. create a normal commit with a descriptive message;
5. push that branch to `origin` and report the branch and commit SHA.

Do not push directly to `main`. Do not force-push, delete remote refs or tags, rewrite existing commits, change Git credentials/remotes, merge a pull request, or modify repository rules/settings. Do not commit secrets, generated credentials, local runtime state, or ignored files.

Commit and push capability is not permission to act automatically. If the user did not request commit or push, stop after the requested implementation and validation.

## Safety boundary

Repository Git access does not authorize host operations. Do not install/reload LaunchAgents, restart Docker or DevSpace, change network exposure, alter host-only control-plane files, or perform live activation unless the user separately and explicitly requests that operation.
