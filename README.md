# pi-science-research

Pi-native scientific research infrastructure for secure scholarly acquisition, evidence tracking, and citation-ready workflows.

> [!IMPORTANT]
> **Early development:** the package currently provides secure scholarly acquisition tools, scholarly evidence and citation foundations, durable ledger and storage primitives, and read-only `/research-status`. The complete `/research` multi-agent workflow is not available yet; it is on the [Roadmap](#roadmap).

## Available today

- **`academic_search`** searches Crossref, OpenAlex, and PubMed.
- **`academic_fetch`** accepts a DOI, PMID, or PMCID and may retrieve PMC BioC text when available.
- Scholarly identifier normalization, source identity, lineage, evidence admission and query, and citation mapping foundations.
- Durable event ledgers, retry state, immutable transactions, owned run roots, and read-only status inspection.

The academic tools are agent-callable tools, not slash commands. Their results have `provenanceStatus: "uncommitted"`: the package does not save raw provider payloads, create a durable cache, or create an implicit durable research run. Normal Pi session persistence still applies to tool calls and rendered results.

## Requirements

- Node.js 22.19.0 or newer
- [Pi](https://github.com/badlogic/pi-mono)

## Install

Install the package for Pi:

```bash
pi install git:github.com/Ray0907/pi-science-research
```

The package manifest automatically loads the research extension. To load it temporarily without installing:

```bash
pi -e git:github.com/Ray0907/pi-science-research
```

Pi packages execute with full system access. Install packages only from sources you trust.

## Use

Ask Pi naturally; the agent can call the academic tools when appropriate:

```text
Search PubMed and OpenAlex for recent systematic reviews of retrieval-augmented generation in medicine.
```

```text
Fetch DOI 10.1038/s41586-023-06747-5 and summarize the available metadata.
```

For an existing durable research run, inspect its verified status with the user command:

```text
/research-status <run-root>
```

Calling `/research-status` with no argument reports that there is no active research run. It does not create or repair one.

## Security model

Scholarly acquisition is intentionally constrained:

- Provider traffic is limited to fixed Crossref, OpenAlex, PubMed, and PMC origins.
- Every network hop re-resolves the hostname, validates all returned DNS addresses, and pins the connection to one validated DNS-resolved address while preserving normal CA trust and hostname verification. This is address pinning, **not certificate pinning**.
- Deadlines, redirects, headers, encoded and decoded bodies, JSON structure, visible output, and provider results are strictly bounded.
- Cancellation, settlement, resource release, and client shutdown have explicit cleanup paths.
- Tests deny ambient network access, and AST audits constrain transport and capability usage. These are test and audit controls, not a runtime sandbox.

This model narrows the package's acquisition behavior; it does not change Pi's full system access security boundary.

## Public API

The package root exports validated high-level contracts and helpers for:

- durable research records, ledgers, retries, transactions, and run roots;
- scholarly identifiers, source identity, lineage, evidence evaluation, queries, and citations;
- academic acquisition result contracts and the production acquisition client.

Transport adapters, schedulers, provider payloads, and other capability-bearing seams remain package-private.

## Development

```bash
npm install
npm run check
```

The current suite contains 912 tests across 42 test files, including package, isolation, capability, transport, lifecycle, and no-network checks.

## Roadmap

- Complete `/research` multi-agent orchestration with resumable research, verification, and synthesis.
- Admit acquisition outcomes into durable canonical evidence through an explicit run-owned sink.
- Produce `report.md` and `evidence.json` research outputs with numbered citations.
- Support optional reproducible calculation and artifact outputs.

## License

[MIT](LICENSE)
