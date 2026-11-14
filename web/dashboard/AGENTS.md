# Dashboard invariants

- Scripts load only from files: `_headers` gives `/dashboard/*` its own Content-Security-Policy after detaching the site-wide one (`! Content-Security-Policy`). Without the detach both policies are sent and enforced together, so the site-wide `default-src 'none'` and `form-action 'none'` block every script and the sign-in form. A page that needs more (WebAssembly, a worker) adds it to that one rule.
- Live views poll through `poll()` in `shell.js`, never their own timer: the connection-lost banner counts failures across every poller on the page and only `poll()` feeds it.
- After a page action that changes what other views poll (Clear events), call `refresh()` from `shell.js`. A poll already in flight may have been answered before the change, and without it that reply redraws the old data for one cycle.
