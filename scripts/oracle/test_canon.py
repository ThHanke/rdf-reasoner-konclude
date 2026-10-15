import os, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(__file__))
import canon

NS = "http://t/"
TBOX = f"""<{NS}hasChild> <{canon.OWL}equivalentProperty> <{NS}isParentOf> .
<{NS}hasChild> <{canon.OWL}inverseOf> <{NS}isChildOf> .
<{NS}hasChild> <{canon.RDF_TYPE}> <{canon.OWL}ObjectProperty> .
<{NS}isParentOf> <{canon.RDF_TYPE}> <{canon.OWL}ObjectProperty> .
<{NS}isChildOf> <{canon.RDF_TYPE}> <{canon.OWL}ObjectProperty> .
"""


class CanonTest(unittest.TestCase):
    def setUp(self):
        f = tempfile.NamedTemporaryFile("w", suffix=".nt", delete=False)
        f.write(TBOX); f.close()
        self.ax = canon.load_axioms(f.name)
        os.unlink(f.name)

    def b(self, triples):
        p, e, i = self.ax
        return canon.fingerprint(canon.bucket(triples, p, e, i))

    def test_synonym_representative_flip_is_equal(self):
        a = self.b([(NS + "x", NS + "hasChild", NS + "y")])
        c = self.b([(NS + "x", NS + "isParentOf", NS + "y")])
        d = self.b([(NS + "y", NS + "isChildOf", NS + "x")])
        self.assertEqual(a, c)
        self.assertEqual(a, d)

    def test_missing_triple_detected(self):
        full = self.b([(NS + "x", NS + "hasChild", NS + "y"), (NS + "x", NS + "hasChild", NS + "z")])
        part = self.b([(NS + "x", NS + "hasChild", NS + "y")])
        self.assertNotEqual(full, part)
        self.assertEqual(part[NS + "hasChild"]["count"], 1)

    def test_types_and_other_bucketed(self):
        fp = self.b([(NS + "x", canon.RDF_TYPE, NS + "C"), (NS + "a", NS + "subPropertyOf", NS + "b")])
        self.assertEqual(fp["__types__"]["count"], 1)
        self.assertEqual(fp["__other__"]["count"], 1)


if __name__ == "__main__":
    unittest.main()
