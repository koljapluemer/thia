# Local CMS

Run `mise run cms` from the checkout and open the loopback URL printed by Streamlit. Local reads use `server-data/`. Start the dev stack to populate the local database and serve the site. Set `GESTALTS_CMS_SITE` if the site starts on a port other than 5177.

## Review and edit

1. Choose a submission, inspect the snapshot, select the catalog names, and enter concept weights as a YAML mapping.
2. Prepare the import and review the diff. Apply it to your checkout and make any edits in Catalog or your editor.
3. Normalize its deck with `mise run publish-data <deck directory>`. If the import adds model definitions, run `mise run gestalts:publish`. Run `mise run check` and `mise run site:build`, and open the candidate on the local site to try the sandboxed view. Restart the site dev server after adding a plugin or model package so it reloads the distribution.
4. Commit the checked sources, then record acceptance using the committed catalog path. If SSH fails, retry recording the decision from the same commit. The next production build publishes it. Rejection requires a note and takes effect immediately.

## SSH setup

Install `cms/data.py` as a trusted, read-only file on the host. Give a dedicated key access as the data owner, with a forced command in that account's authorized keys. Use `restrict,command="/usr/bin/python3 /opt/thia-admin/data.py /var/lib/thia-server" ssh-ed25519 …`. The helper only needs Python's standard library. Configure the key and verified host key in your local SSH config, then set `GESTALTS_CMS_SSH` to that SSH destination and select SSH in the CMS. Local development remains the default.

## Model jobs

Select a plugin, model, and prompt in Runs. Ollama defaults to `http://127.0.0.1:11434` and uses a model you already have. Gemini uses `GEMINI_API_KEY` from the process environment and sends your prompt and requested plugin files to Google. With each provider, try a small copy edit to one plugin, refresh the run list, inspect the run log and diff, then apply it if desired. Jobs stay under `target/cms/jobs/`. Local jobs edit plugin files independently of the MCP drafting workflow.

Claude Code and Codex can edit the checkout directly. The shared instructions are in `.claude/skills/edit-plugin/SKILL.md`, which Claude Code discovers from this repo. Install a copy of its containing directory into Codex's skills directory to use it there.
