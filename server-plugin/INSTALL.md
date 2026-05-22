# CNZ Server Plugin — Installation Guide

The CNZ server plugin runs inside SillyTavern's Node.js process and provides the
SQLite vector store that backs all RAG retrieval. It must be installed correctly or
ST will log a load failure and RAG will silently do nothing.

---

## Why this is tricky

`better-sqlite3` is a **native Node.js addon** — it contains compiled C++ code
(a `.node` binary) that links against the Node.js runtime. That binary must be
compiled for the **exact Node.js version and build variant** running inside the
ST Docker container.

If you copy `node_modules/` from your development machine (or code-server), you
get a binary compiled for your machine's Node.js — which will almost certainly
have a different ABI or shared-library layout than the one inside the container.

Symptom in the ST log:
```
Failed to load plugin from .../plugins/cnz/index.js:
Error loading shared library libnode.so.109: No such file or directory
(needed by .../node_modules/better-sqlite3/build/Release/better_sqlite3.node)
```

The number after `libnode.so.` is the ABI version of wherever `npm install` was
run. The container's Node.js doesn't expose a shared library at that path, so the
binary is dead on arrival.

**Rule: `npm install` for this plugin must always run inside the ST container.**

---

## First-time installation

1. Copy the plugin directory into the plugins folder that ST mounts:

   ```bash
   cp -r server-plugin/. /path/to/sillytavern/st-plugins/cnz
   ```

2. Run `npm install` **inside the running container** to get the correct binary:

   ```bash
   docker exec sillytavern sh -c "cd /home/node/app/plugins/cnz && rm -rf node_modules && npm install"
   ```

   `rm -rf node_modules` first ensures no stale binaries survive from outside the
   container. npm will download a pre-built binary matched to the container's
   Node.js version, or compile from source if no pre-built is available.

3. Restart ST so it retries the plugin load:

   ```bash
   docker compose restart sillytavern
   ```

4. Confirm the plugin loaded and the DB was created:

   ```bash
   # Should return JSON with chunk counts (empty on first run)
   curl -u "user:password" http://sillytavern:8000/api/plugins/cnz/health
   
   # DB file should exist
   ls st-plugins/cnz/cnz.db
   ```

---

## After updating the plugin source

When you change `db.js`, `routes.js`, or `embed.js`:

```bash
# 1. Copy updated JS files (node_modules stays — don't overwrite it)
cp server-plugin/db.js      st-plugins/cnz/db.js
cp server-plugin/embed.js   st-plugins/cnz/embed.js
cp server-plugin/routes.js  st-plugins/cnz/routes.js
cp server-plugin/index.js   st-plugins/cnz/index.js

# 2. Restart ST
docker compose restart sillytavern
```

Only run `npm install` again inside the container if `package.json` changes
(i.e. you added or removed a dependency).

---

## After a full container recreate (`docker compose up --force-recreate`)

The `node_modules/` directory lives in the host-mounted volume (`st-plugins/cnz/`),
so it survives container recreates. However, if the ST image is ever updated to a
new Node.js version, the binary will break again.

When that happens, re-run the install step:

```bash
docker exec sillytavern sh -c "cd /home/node/app/plugins/cnz && rm -rf node_modules && npm install"
docker compose restart sillytavern
```

---

## Why the compose `command` workaround doesn't work

The ST image uses `docker-entrypoint.sh` as its ENTRYPOINT. That script always
runs `npm run init` then `exec node server.js` regardless of what `command:` is
set to in the compose file — the entrypoint ignores the CMD entirely for startup
sequencing. So there is no clean way to inject a pre-start hook via compose alone
without modifying the entrypoint script, which would mean maintaining a fork of
the image.

The manual `docker exec` approach is the correct solution until ST adds a
plugin lifecycle hook (e.g. a per-plugin `install.sh` that runs at startup).

---

## Embedding configuration

The plugin requires an OpenRouter API key and model to generate embeddings.
Local embedding (`@xenova/transformers`) has been removed — it crashed ST on
Node v24 due to ONNX Runtime incompatibility.

In CNZ settings → RAG Settings → Retrieval Settings:
- **Embedding Source**: OpenRouter
- **Embedding Model**: `qwen/qwen3-embedding-8b` (recommended) or any OpenRouter embedding model
- **API Key**: your OpenRouter key

Without a valid embedding config, insert and query calls will return an error
and chunks will not be indexed.
