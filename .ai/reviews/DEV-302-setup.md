# DEV-302 one-time autorun setup script (PR #328) — Fresh Review

Independent reviewer (separate context, read-only; the protected script run only in the fake WSL of setup.test.ts).
Base `feature/dev302-imagefirst-config-trust` 5859f21a (PR #326). OWNER MERGE ONLY.

## Round 1 — a0d45d92 — PASS (C0 / H0 / M2 / L5)

- Sound: env -i, absolute root-owned /usr/bin/npm and node, npm user/global config /dev/null, HOME=/root, setup.log
  root 0600 in a 0700 dir, restore targets limited to /home/sr-designgen, check read-only, apply idempotent and fail
  closed, hardening ok-file bound to the service and admin.sh SHA-256, enable-timer unreachable unless all DONE,
  rollback never touches used/ autorun/ claims ledgers.
- M1: vendor postinstall (claude-code `node install.cjs`) ran as root with no integrity pin → pinned registry URL +
  sha512 of 4 tarballs and SHA-256 of 2 native binaries, download and verify first, `npm -g --ignore-scripts
  --omit=optional` from local tarballs, per-file compare, the script places the native binaries itself.
- M2: proxy / CA variables reached npm → env allowlist PATH, LANG, TZ only.
- L: test copy refuses uid 0; hardening check uses the unit's full [Service] set (tested both ways); rollback undoes
  only what setup.log recorded; doc warns rollback restores root links into the user's home; native must be a real
  ELF with the pinned SHA-256; doc exit codes.

## Round 2 — 888a8a35 — PASS (L4)

- Extraction sound (sha512 before tar, only plain files/dirs under package/, no `..`, no-same-owner/permissions,
  fresh mktemp dir removed on every exit). L: curl size cap; rollback stuck after partial failure; extra installed
  files; setuid/setgid bits.

## Round 3 — df3f265c — PASS (nits only)

- Pinned sizes + `--max-filesize` + 1024 MiB free check; idempotent rollback; exact file set; special bits refused and
  stripped. Nits: an unquoted variable in one failure message; free space measured on the state dir's filesystem.

Not verified on the real machine (stubs only): real npm 10 global install from local tarballs with
`--omit=optional`, and systemd-run accepting every unit property. Both fail closed with the rollback line.
CI: the run on a0d45d92 failed only on the unrelated `rc-diagnose.test.ts` 5 s timeout (also seen on #326).
