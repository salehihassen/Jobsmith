"""Country checks run at the save boundary, including recovered partial fetches."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend import app_state as state, background_tasks as bg
from backend.services import country_eligibility as ce


FOREIGN = {
    "source": "weworkremotely", "title": "Operations Support Specialist",
    "location": "Remote", "is_remote": True,
    "description": "We are only considering candidates based in South Africa, Latin America, or Eastern Europe.",
    "url": "https://example.com/foreign",
}
CONFIG = {"profile": {"country": "United States"},
          "search": {"hiring_country": "United States"}}


@pytest.mark.asyncio
@pytest.mark.parametrize("partial", [False, True])
async def test_ineligible_remote_never_reaches_database(monkeypatch, tmp_path, partial):
    async def fetch(*args, **kwargs):
        if partial:
            kwargs["_partial_collector"].append(dict(FOREIGN))
            raise asyncio.TimeoutError
        return [dict(FOREIGN)]

    async def classify(postings, country, config):
        return {p["id"]: {"decision": "ineligible", "evidence": FOREIGN["description"]} for p in postings}

    monkeypatch.setattr(state, "load_config", lambda: CONFIG)
    monkeypatch.setattr(state, "push_notification", lambda *a: None)
    monkeypatch.setattr(bg, "fetch_all_jobs", fetch)
    monkeypatch.setattr(ce, "project_root", lambda: tmp_path)
    monkeypatch.setattr(ce, "_classify_batch", classify)
    save = AsyncMock()
    monkeypatch.setattr(bg.db, "upsert_job", save)
    monkeypatch.setattr(bg.db, "log_activity", AsyncMock())
    monkeypatch.setattr(bg.db, "gc_deleted_jobs", AsyncMock(return_value=0))
    monkeypatch.setattr(bg, "_refresh_job_quality", AsyncMock())
    await bg._bg_fetch_jobs(["weworkremotely"])
    save.assert_not_awaited()
    assert not state.fetch_status["active"]
    assert state.fetch_status["country_filter"] == {"eligible": 0, "ineligible": 1, "unknown": 0}


@pytest.fixture
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(ce, "project_root", lambda: tmp_path)
    return tmp_path


def _posting(description, **kwargs):
    return {**FOREIGN, "description": description, **kwargs}


@pytest.mark.asyncio
async def test_evidence_unknowns_and_cache(monkeypatch, isolated):
    jobs = [_posting("Open to US residents."), _posting("Hiring worldwide."),
            dict(FOREIGN), _posting("Remote."), _posting("Based in Germany.")]
    verdicts = [
        {"decision": "eligible", "evidence": "US residents"},
        {"decision": "eligible", "evidence": "Hiring worldwide."},
        {"decision": "ineligible", "evidence": "South Africa, Latin America, or Eastern Europe"},
        {"decision": "unknown", "evidence": ""},
        {"decision": "eligible", "evidence": "Hiring in United States"},  # fabricated quote
    ]

    async def classify(postings, country, config):
        return {p["id"]: verdicts[p["id"]] for p in postings}

    call = AsyncMock(side_effect=classify)
    monkeypatch.setattr(ce, "_classify_batch", call)
    kept = await ce.filter_jobs_for_country(jobs, CONFIG)
    assert kept == jobs[:2]
    report = ce._read_json(ce.report_path())
    assert report["counts"] == {"eligible": 2, "ineligible": 1, "unknown": 2}
    assert report["jobs"][4]["reason"] == "AI evidence could not be verified"
    call.reset_mock()
    await ce.filter_jobs_for_country(jobs[:3], CONFIG)
    call.assert_not_awaited()
    await ce.filter_jobs_for_country([_posting("Open to US residents, except Virginia.")], CONFIG)
    assert call.await_count == 1  # a changed posting must be rechecked


@pytest.mark.asyncio
async def test_country_change_invalidates_cache(monkeypatch, isolated):
    call = AsyncMock(return_value={0: {"decision": "eligible", "evidence": "Hiring worldwide."}})
    monkeypatch.setattr(ce, "_classify_batch", call)
    jobs = [_posting("Hiring worldwide.")]
    await ce.filter_jobs_for_country(jobs, CONFIG)
    await ce.filter_jobs_for_country(jobs, {"search": {"hiring_country": "Brazil"}})
    assert call.await_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [RuntimeError("provider unavailable"), ValueError("invalid JSON")])
async def test_outage_holds_jobs_without_caching_failure(monkeypatch, isolated, error):
    call = AsyncMock(side_effect=error)
    monkeypatch.setattr(ce, "_classify_batch", call)
    assert await ce.filter_jobs_for_country([FOREIGN], CONFIG) == []
    assert ce._read_json(ce.report_path())["counts"]["unknown"] == 1
    assert ce._read_json(ce.report_path().with_name("country_filter_cache.json")) == {}


@pytest.mark.asyncio
async def test_disabled_makes_no_calls(monkeypatch, isolated):
    call = AsyncMock()
    monkeypatch.setattr(ce, "_classify_batch", call)
    assert await ce.filter_jobs_for_country([FOREIGN], {"search": {}}) == [FOREIGN]
    call.assert_not_awaited()


@pytest.mark.asyncio
async def test_large_description_is_held_instead_of_truncated(monkeypatch, isolated):
    call = AsyncMock()
    monkeypatch.setattr(ce, "_classify_batch", call)
    assert await ce.filter_jobs_for_country([_posting("a" * 24001)], CONFIG) == []
    call.assert_not_awaited()


@pytest.mark.asyncio
async def test_cancel_stops_checks(monkeypatch, isolated):
    call = AsyncMock()
    monkeypatch.setattr(ce, "_classify_batch", call)
    with pytest.raises(asyncio.CancelledError):
        await ce.filter_jobs_for_country([FOREIGN], CONFIG, cancelled=lambda: True)
    call.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("results", [[], [{"id": 0}, {"id": 0}], [{"id": "0"}], [{"id": True}]])
async def test_invalid_batch_cannot_shift_decisions_between_jobs(monkeypatch, results):
    response = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({"results": results})))])
    monkeypatch.setattr(ce.ai_engine, "get_client", AsyncMock())
    monkeypatch.setattr(ce.ai_engine, "_model", lambda *a: "existing-utility-model")
    monkeypatch.setattr(ce.ai_engine, "_llm_create_with_retry", AsyncMock(return_value=response))
    with pytest.raises(ValueError):
        await ce._classify_batch([{"id": 0}], "United States", {})
