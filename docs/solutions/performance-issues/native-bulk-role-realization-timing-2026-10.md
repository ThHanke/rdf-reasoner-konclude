---
title: Upstream Konclude can run the bulk role-realization step; timing vs WASM
date: 2026-10-16
module: tests/bench
problem_type: performance
tags: [benchmark, role-closure, OPSROLEREALIZE, native, roberts, konclude-config]
---

# Upstream Konclude's bulk role realization is a config switch

## Finding

`CRealizeQuery` reads `Konclude.Calculation.Realization.RealizePrecomputation.RoleInstances` (default **false**). With it true, the unmodified `konclude/konclude` image's `realization` command runs the bulk role-realization step (`OPSROLEREALIZE`) that this package's WASM `realization()` always requests. Its OWL/XML output still lists class assertions only, but the work is done and shows in "Total processing time".

```xml
<RequestMessage xmlns="http://www.owllink.org/owllink-xml#">
  <Set key='Konclude.Calculation.Realization.RealizePrecomputation.RoleInstances'><Literal>true</Literal></Set>
</RequestMessage>
```

```bash
docker run --rm -v DIR:/t konclude/konclude:latest realization -v -w 8 -c /t/cfg.xml -i /t/ont.owl.xml -o /t/out.xml
```

## Numbers (idle host, 8 threads, 3 runs, Konclude's own total)

| Ontology | Konclude default (types) | Konclude `RoleInstances=true` | WASM full realization |
| --- | --- | --- | --- |
| Roberts family | 2198 ms | 38118 ms [37754–38363] | 27490 ms |
| LUBM schema + data | 1240 ms | 1245 ms [1240–1246] | 3579 ms |

WASM is ~1.4x faster than unmodified native on Roberts and ~2.9x slower on LUBM+data, where the role step is negligible and the fixed WASM start cost dominates.

## Dead ends (and why they were misleading)

- A SPARQL query per object property in one `sparqlfile` run does return the closure, but it takes the lazy per-individual route (`OPSANSWERCOMPLEXQUERY`, "N realization requests"): 91-354 s on Roberts depending on host load. Real Konclude, wrong code path for comparison.
- OWLlink `GetFlattenedObjectPropertyTargets` for one Roberts individual returned an empty set.
- The native `konclude_repro` harness (same patched kernel, `-g3 -O1`) took 40-49 s for the same step, but it is a modified kernel, so it is not used for the comparison.
