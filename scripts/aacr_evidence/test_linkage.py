import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location("builder",Path(__file__).with_name("build_evidence_bundle.py"));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
C={"normalized_candidate":"NCT01234567","response_sha256":"a"*64}
F={"nct_id":"NCT01234567","brief_title":"ABC-123 in colorectal cancer","official_title":None,"conditions":["Colorectal Cancer"],"interventions":["ABC-123"],"lead_sponsor":"Acme Therapeutics","collaborators":[],"phases":["PHASE1"],"overall_status":"RECRUITING","start_date":"2025-01","primary_completion_date":None}
def rec(text):return {"id":"r1","doi":"d1","title":"AACR abstract","abstract":text}
class TestLinkage(unittest.TestCase):
 def test_direct(self):self.assertEqual(m.classify_linkage(C,[rec("Trial NCT01234567 reports results")],F)["decision"],"CONFIRMED_DIRECT_LINK")
 def test_contextual_strict(self):self.assertEqual(m.classify_linkage(C,[rec("Acme Therapeutics reports ABC-123 in colorectal cancer")],F)["decision"],"CONFIRMED_CONTEXTUAL_LINK")
 def test_ambiguous(self):self.assertEqual(m.classify_linkage(C,[rec("A colorectal cancer cohort was studied")],F)["decision"],"AMBIGUOUS_REVIEW_REQUIRED")
 def test_unlinked(self):self.assertEqual(m.classify_linkage(C,[rec("A melanoma imaging biomarker study")],F)["decision"],"REAL_NCT_UNLINKED_TO_ABSTRACT")
 def test_not_found(self):self.assertEqual(m.classify_linkage(C,[rec("NCT01234567")],None)["decision"],"NOT_FOUND")
 def test_receipt_deterministic(self):self.assertEqual(m.classify_linkage(C,[rec("NCT01234567")],F)["receipt_id"],m.classify_linkage(C,[rec("NCT01234567")],F)["receipt_id"])
if __name__=="__main__":unittest.main()
