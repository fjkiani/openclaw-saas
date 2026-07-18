import { describe, expect, it, vi } from "vitest";
vi.mock("@workspace/db",()=>({pool:{query:vi.fn()}}));
import { claimEligible } from "../../lib/aacrEvidencePolicy";
const base={field_name:"brief_title",value_json:"Study title",source_state:"CLINICALTRIALS_GOV_API_V2",lifecycle_status:"REGISTRY_VERIFIED",permitted_use:"INTERNAL_VALIDATED_SUBSET",claim_eligible:true};
describe("AACR claim eligibility policy",()=>{
  it("allows receipted registry facts",()=>expect(claimEligible(base)).toBe(true));
  it("blocks model extraction even if stored eligible",()=>expect(claimEligible({...base,source_state:"MODEL_EXTRACTION"})).toBe(false));
  it.each(["opportunity_score","commercial_rank","clinical_utility","bd_assertion","white_space"])("blocks prohibited field %s",field=>expect(claimEligible({...base,field_name:field})).toBe(false));
  it.each(["white space","clinically actionable","first-in-class","opportunity ranking"])("blocks prohibited assertion %s",value=>expect(claimEligible({...base,value_json:value})).toBe(false));
  it("blocks quarantined claims",()=>expect(claimEligible({...base,lifecycle_status:"QUARANTINED"})).toBe(false));
  it("blocks external-not-authorized claims",()=>expect(claimEligible({...base,permitted_use:"EXTERNAL_NOT_AUTHORIZED"})).toBe(false));
});
