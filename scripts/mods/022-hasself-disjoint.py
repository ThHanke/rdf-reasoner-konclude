#!/usr/bin/env python3
"""
022-hasself-disjoint.py — Insert hasSelf + propertyDisjointWith clash checks
into applySELFRule of the saturation approximation algorithm.

Root cause: applySELFRule creates backward-propagation links but never checks
disjoint roles. When BackendAssCache marks the node CompletelyHandled, the
completion algorithm's expansion-blocking skips its own applySELFRule (which
checks disjoint roles via createIndividualNodeDisjointRolesLinks). Result:
hasSelf(p) + hasSelf(q) + p owl:propertyDisjointWith q is reported consistent.

Fix: add two checks at the top of applySELFRule before the back-prop loop:
  1. Self-disjoint: if any super-role of role is disjoint with itself -> clash
  2. Cross-hasSelf: if existing label already has CCSELF for a disjoint role -> clash

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

OLD = (
    "\t\t\t\t\tCSortedNegLinker<CConcept*>* conceptOpLinkerIt = concept->getOperandList();\n"
    "\n"
    "\n"
    "\t\t\t\t\tCMemoryAllocationManager* taskMemMan = nullptr;\n"
)

NEW = (
    "\t\t\t\t\tCSortedNegLinker<CConcept*>* conceptOpLinkerIt = concept->getOperandList();\n"
    "\n"
    "\t\t\t\t\t// hasSelf + propertyDisjointWith clash detection.\n"
    "\t\t\t\t\t// The saturation creates backward-propagation links but no completion-graph\n"
    "\t\t\t\t\t// role links.  When BackendAssCache marks a node CompletelyHandled the\n"
    "\t\t\t\t\t// completion's expansion-blocking prevents its own applySELFRule (which\n"
    "\t\t\t\t\t// calls createIndividualNodeDisjointRolesLinks) from ever running.\n"
    "\t\t\t\t\t// Detect the clash here so the saturation flags the node as CLASHED.\n"
    "\t\t\t\t\t//\n"
    "\t\t\t\t\t// Check 1: any super-role of role is disjoint with itself.\n"
    "\t\t\t\t\t// hasSelf(r) with r owl:propertyDisjointWith r -> immediate clash.\n"
    "\t\t\t\t\t{\n"
    "\t\t\t\t\t\tCSortedNegLinker<CRole*>* srIt = role->getIndirectSuperRoleList();\n"
    "\t\t\t\t\t\twhile (srIt) {\n"
    "\t\t\t\t\t\t\tCRole* sr = srIt->getData();\n"
    "\t\t\t\t\t\t\tif (!srIt->isNegated() && sr->hasDisjointRole(sr)) {\n"
    "\t\t\t\t\t\t\t\tupdateDirectAddingIndividualStatusFlags(\n"
    "\t\t\t\t\t\t\t\t\tprocessIndi,\n"
    "\t\t\t\t\t\t\t\t\tCIndividualSaturationProcessNodeStatusFlags::INDSATFLAGCLASHED,\n"
    "\t\t\t\t\t\t\t\t\tmCalcAlgContext);\n"
    "\t\t\t\t\t\t\t\treturn;\n"
    "\t\t\t\t\t\t\t}\n"
    "\t\t\t\t\t\t\tsrIt = srIt->getNext();\n"
    "\t\t\t\t\t\t}\n"
    "\t\t\t\t\t}\n"
    "\t\t\t\t\t// Check 2: existing CCSELF concept in the label uses a role disjoint\n"
    "\t\t\t\t\t// with role.  hasSelf(p) in label + hasSelf(q) firing now + p disjoint q\n"
    "\t\t\t\t\t// -> clash.  The last of two conflicting hasSelf rules to fire detects it.\n"
    "\t\t\t\t\t{\n"
    "\t\t\t\t\t\tCReapplyConceptSaturationLabelSet* existingConSet =\n"
    "\t\t\t\t\t\t\tprocessIndi->getReapplyConceptSaturationLabelSet(false);\n"
    "\t\t\t\t\t\tif (existingConSet) {\n"
    "\t\t\t\t\t\t\tCReapplyConceptSaturationLabelSetIterator it =\n"
    "\t\t\t\t\t\t\t\texistingConSet->getIterator(true, false);\n"
    "\t\t\t\t\t\t\twhile (it.hasNext()) {\n"
    "\t\t\t\t\t\t\t\tCConceptSaturationDescriptor* cd =\n"
    "\t\t\t\t\t\t\t\t\tit.getConceptSaturationDescriptor();\n"
    "\t\t\t\t\t\t\t\tif (cd && !cd->getNegation() &&\n"
    "\t\t\t\t\t\t\t\t\t\tcd->getConcept()->getOperatorCode() == CCSELF) {\n"
    "\t\t\t\t\t\t\t\t\tCRole* existingSelfRole = cd->getConcept()->getRole();\n"
    "\t\t\t\t\t\t\t\t\tif (role->hasDisjointRole(existingSelfRole)) {\n"
    "\t\t\t\t\t\t\t\t\t\tupdateDirectAddingIndividualStatusFlags(\n"
    "\t\t\t\t\t\t\t\t\t\t\tprocessIndi,\n"
    "\t\t\t\t\t\t\t\t\t\t\tCIndividualSaturationProcessNodeStatusFlags::INDSATFLAGCLASHED,\n"
    "\t\t\t\t\t\t\t\t\t\t\tmCalcAlgContext);\n"
    "\t\t\t\t\t\t\t\t\t\treturn;\n"
    "\t\t\t\t\t\t\t\t\t}\n"
    "\t\t\t\t\t\t\t\t}\n"
    "\t\t\t\t\t\t\t\tit.moveNext();\n"
    "\t\t\t\t\t\t\t}\n"
    "\t\t\t\t\t\t}\n"
    "\t\t\t\t\t}\n"
    "\n"
    "\t\t\t\t\tCMemoryAllocationManager* taskMemMan = nullptr;\n"
)

# Normalize CRLF to LF for matching, then write back with original line endings
src_lf = src.replace("\r\n", "\n")

if OLD not in src_lf:
    sys.stderr.write(
        "ERROR: context not found — OLD pattern missing from source.\n"
        "Check indentation (expected 5 tabs) and blank-line count.\n"
    )
    sys.exit(1)

out_lf = src_lf.replace(OLD, NEW, 1)
if out_lf == src_lf:
    sys.stderr.write("ERROR: replace produced no change\n")
    sys.exit(1)

# Restore original line endings
original_crlf = "\r\n" in src
if original_crlf:
    out = out_lf.replace("\n", "\r\n")
else:
    out = out_lf

with open(path, "w", encoding="utf-8", newline="") as f:
    f.write(out)

print(f"Patched: {path}")
