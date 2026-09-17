#!/usr/bin/env python3
"""
023-asymmetric-self-loop-clash.py — Detect r(a,a) + AsymmetricProperty/IrreflexiveProperty clash
in initializeRoleAssertions of CCalculationTableauApproximationSaturationTaskHandleAlgorithm.

Root cause: when patch-012 ABox-iteration checks were reverted (they caused hangs), the safe
self-loop check was also removed. The self-loop check only reads precomputed role flags
(IndirectSuperRoleList, isAsymmetric, isIrreflexive) — no ABox iteration, no hang risk.

Fix: before the othIndiNode lookup in the forward role-assertion loop, if othIndi == nominalIndi
(self-loop), walk getIndirectSuperRoleList() for isAsymmetric() || isIrreflexive() -> CLASHED.

Interface: new-multi-file-patch.sh style.
  --list-files  print the single vendor-relative path and exit
  <vendor_dir>  modify file in-place
"""
import sys
import os

TARGET = "Source/Reasoner/Kernel/Algorithm/CCalculationTableauApproximationSaturationTaskHandleAlgorithm.cpp"

if len(sys.argv) >= 2 and sys.argv[1] == "--list-files":
    print(TARGET)
    sys.exit(0)

vendor_dir = sys.argv[1]
path = os.path.join(vendor_dir, TARGET)

with open(path, "r", encoding="utf-8", errors="replace") as f:
    src = f.read()

# Normalize CRLF → LF for matching (file is CRLF)
src_lf = src.replace("\r\n", "\n")

T = "\t" * 7  # 7-tab indentation of the inner loop body

OLD = (
    T + "CIndividual* othIndi = assRoleLinkerIt->getIndividual();\n"
    + "\n"
    + "\n"
    + T + "CIndividualSaturationProcessNode* othIndiNode = getIndividualNodeForIndividual(indiProcSatNode,othIndi,saturationID,calcAlgContext);\n"
)

NEW = (
    T + "CIndividual* othIndi = assRoleLinkerIt->getIndividual();\n"
    + "\n"
    + T + "// Self-loop clash: r(a,a) with AsymmetricProperty(r) or IrreflexiveProperty(r).\n"
    + T + "// Before othIndiNode lookup — reads only precomputed role flags (set during\n"
    + T + "// preprocessing), no ABox iteration (which hangs all tests in saturation).\n"
    + T + "if (othIndi == nominalIndi) {\n"
    + T + "\t" + "CSortedNegLinker<CRole*>* superRoleIt = role->getIndirectSuperRoleList();\n"
    + T + "\t" + "while (superRoleIt) {\n"
    + T + "\t\t" + "if (!superRoleIt->isNegated() &&\n"
    + T + "\t\t\t\t" + "(superRoleIt->getData()->isAsymmetric() ||\n"
    + T + "\t\t\t\t " + "superRoleIt->getData()->isIrreflexive())) {\n"
    + T + "\t\t\t" + "updateDirectAddingIndividualStatusFlags(\n"
    + T + "\t\t\t\t" + "indiProcSatNode,\n"
    + T + "\t\t\t\t" + "CIndividualSaturationProcessNodeStatusFlags::INDSATFLAGCLASHED,\n"
    + T + "\t\t\t\t" + "calcAlgContext);\n"
    + T + "\t\t\t" + "return;\n"
    + T + "\t\t" + "}\n"
    + T + "\t\t" + "superRoleIt = superRoleIt->getNext();\n"
    + T + "\t" + "}\n"
    + T + "}\n"
    + "\n"
    + T + "CIndividualSaturationProcessNode* othIndiNode = getIndividualNodeForIndividual(indiProcSatNode,othIndi,saturationID,calcAlgContext);\n"
)

if OLD not in src_lf:
    sys.stderr.write(
        "ERROR: context not found — OLD pattern missing from source.\n"
        "Check indentation (expected 7 tabs) and blank-line count.\n"
    )
    sys.exit(1)

out_lf = src_lf.replace(OLD, NEW, 1)
if out_lf == src_lf:
    sys.stderr.write("ERROR: replace produced no change\n")
    sys.exit(1)

# Restore original CRLF line endings
original_crlf = "\r\n" in src
if original_crlf:
    out = out_lf.replace("\n", "\r\n")
else:
    out = out_lf

with open(path, "w", encoding="utf-8", newline="") as f:
    f.write(out)

print(f"Patched: {path}")
