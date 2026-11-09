# Tenor API clients

Official clients for the [Tenor Trading API](https://trading-api.tenor.finance/v1/docs).

| Language   | Package                                                                          | Docs                                       |
| ---------- | -------------------------------------------------------------------------------- | ------------------------------------------ |
| TypeScript | [`@tenor-labs/api-client`](https://www.npmjs.com/package/@tenor-labs/api-client) | [packages/typescript](packages/typescript) |
| Python     | [`tenor-api-client`](https://pypi.org/project/tenor-api-client/)                 | [packages/python](packages/python)         |

Both clients are generated from the API's OpenAPI spec, so they cover every endpoint, with types for every request and response. Install and usage are in each package's README.

## How it works

```
               Trading API
           GET /v1/openapi.json
                    │
                    │  mise run sync
                    ▼
         openapi/trading-api.json
                    │
                    │  mise run generate
          ┌─────────┴─────────┐
          ▼                   ▼
  packages/typescript   packages/python
          │                   │
          │  git tag v*       │
          ▼                   ▼
         npm                 PyPI
```

1. `sync` copies the prod spec into `openapi/`. It's the only file that changes when the API does.
2. `generate` builds each client from it: types or models, plus a client class with one method per endpoint.
3. Each package adds a small hand-written layer for config, the API key, retries and errors.
4. Pushing a `v*` tag regenerates, tests and publishes both packages at that version.

## Repo layout

```
openapi/trading-api.json   the spec the clients are generated from, synced from prod
packages/typescript/       the npm package
packages/python/           the PyPI package
scripts/sync-spec.mjs      fetches the spec from prod
```

Generated code isn't committed. Each package generates it from `openapi/` when you build or test.

## Development

You need [mise](https://mise.jdx.dev). After cloning:

```sh
mise install
(cd packages/typescript && npm ci)
(cd packages/python && uv sync)
mise run generate
```

`mise run check` regenerates, then typechecks, lints, tests and builds both packages. `mise run test:live` makes a few read-only calls against prod.

## Releasing

When the API changes in prod:

```sh
mise run sync      # pull the new spec into openapi/
mise run check
git commit -am "chore: sync the prod spec"
git tag -a v0.2.0 -m "v0.2.0" && git push --follow-tags
```

The tag publishes both packages at that version. There's also a weekly GitHub Action that opens a PR when the prod spec has changed, so you only have to review it, merge and tag.

Client versions follow semver on their own, separate from the API's `/v1`.

## Adding a language

Add `packages/<language>`, generated from `openapi/trading-api.json`. Keep it as close to the others as you can:

- the same client options;
- the same error fields;
- the same retries.

Then add `generate:<language>` and `check:<language>` tasks to `mise.toml`, and a publish job to `.github/workflows/release.yml`.

## License

MIT
