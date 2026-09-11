# Release

`skillenv` publishes to npm from Git tags
(`.github/workflows/release.yml`).

1. Update the version in `package.json` **and** `src/version.ts` (keep them in
   sync).
2. Update `CHANGELOG.md`.
3. Run the gates:

```bash
npm run typecheck
npm test
npm run build
node dist/cli.js version
```

4. Commit the release change.
5. Tag and push:

```bash
git tag v2.0.0
git push origin rewrite/typescript-v2 --tags
```

6. The workflow verifies the tag matches `package.json`, runs the gates again,
   and publishes `@kobelyww/skillenv` with `--access public`. It requires the
   `NPM_TOKEN` repository secret.
