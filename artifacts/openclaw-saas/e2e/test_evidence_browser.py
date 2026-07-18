import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE_URL = "http://127.0.0.1:4173"
TOKEN = "evidence-browser-service-token-00000001"
RESULTS = Path("/mnt/results")

receipts = {"base_url": BASE_URL, "checks": {}}
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(
        viewport={"width": 1440, "height": 1000},
        extra_http_headers={"Authorization": f"Bearer {TOKEN}"},
    )
    page = context.new_page()

    page.goto(f"{BASE_URL}/evidence", wait_until="networkidle")
    expect(page.get_by_text("AACR Evidence Explorer", exact=True)).to_be_visible()
    expect(page.get_by_test_id("evidence-search")).to_be_visible()
    page.screenshot(path=str(RESULTS / "aacr_evidence_explorer.png"), full_page=True)
    receipts["checks"]["explorer_loaded"] = True

    page.goto(f"{BASE_URL}/evidence/targets/WRN", wait_until="networkidle")
    expect(page.get_by_text("WRN evidence profile", exact=True)).to_be_visible()
    studies = page.locator("[data-testid^='target-study-']")
    assert studies.count() == 39, f"Expected 39 WRN records, saw {studies.count()}"
    expect(page.get_by_text("QUERY_RETRIEVAL_ONLY_LINKAGE_UNVERIFIED", exact=True)).to_be_visible()
    page.get_by_text("Association boundary", exact=True).locator("..").locator("..").screenshot(path=str(RESULTS / "aacr_evidence_wrn_profile.png"))
    receipts["checks"]["wrn_protocol_count"] = studies.count()

    page.goto(f"{BASE_URL}/evidence/targets/PKMYT1", wait_until="networkidle")
    pkmyt1_studies = page.locator("[data-testid^='target-study-']")
    assert pkmyt1_studies.count() == 7, f"Expected 7 PKMYT1 records, saw {pkmyt1_studies.count()}"
    receipts["checks"]["pkmyt1_protocol_count"] = pkmyt1_studies.count()

    page.goto(f"{BASE_URL}/evidence/validation", wait_until="networkidle")
    expect(page.get_by_text("AACR Validation Board", exact=True)).to_be_visible()
    expect(page.get_by_text("7485", exact=True)).to_be_visible()
    expect(page.get_by_text("218", exact=True)).to_be_visible()
    expect(page.get_by_text("Prohibited-claim enforcement:")).to_be_visible()
    expect(page.get_by_test_id("prohibited-claim-enforcement")).to_contain_text("ENABLED")
    page.evaluate("""() => { const main=document.querySelector('main'); if(main){main.style.overflow='visible';main.style.height='auto';} const shell=document.getElementById('root')?.firstElementChild; if(shell instanceof HTMLElement){shell.style.height='auto';shell.style.overflow='visible';} }""")
    page.locator("main .max-w-6xl").screenshot(path=str(RESULTS / "aacr_evidence_validation_board.png"))
    receipts["checks"]["validation_board_loaded"] = True

    blocked = {}
    for channel in ["share", "pdf", "email", "bulk-download", "stale-export"]:
        response = context.request.post(f"{BASE_URL}/api/intelligence/evidence/{channel}", data={})
        blocked[channel] = response.status
        assert response.status == 403
    receipts["checks"]["distribution_channels"] = blocked

    browser.close()

(RESULTS / "aacr_evidence_browser_e2e.json").write_text(json.dumps(receipts, indent=2) + "\n")
print(json.dumps(receipts, indent=2))
